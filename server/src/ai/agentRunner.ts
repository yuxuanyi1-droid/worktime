import { Worker } from 'node:worker_threads';
import path from 'path';
import { logger } from '../utils/logger';
import { aiConfig, aiReady, piModelsJsonPath } from '../config/ai';
import { PatService } from '../services/patService';

/**
 * pi agent 主线程适配层。
 *
 * pi SDK 在 worker 线程运行（agentWorker.ts），主线程通过消息驱动。
 * 原因：pi 是纯 ESM 大包，在已加载 CJS 模块的主线程里动态 import() 会死锁事件循环。
 *
 * 单 worker 实例承载所有用户的 pi 会话（pi 的会话在进程内隔离，靠 sessionId 区分）。
 * worker 启动时 import pi（~1.2s），就绪后处理 create/prompt/dispose 消息。
 */

// worker 文件：tsx 运行时直接加载 .ts；生产构建后用 .js。
// 用 existsSync 兼容两种场景。
const WORKER_FILE = ((): string => {
  const base = path.resolve(__dirname, 'agentWorker');
  const fs = require('fs');
  return fs.existsSync(base + '.ts') ? base + '.ts' : base + '.js';
})();

let worker: Worker | null = null;
let workerReady = false;
let workerReadyResolvers: Array<() => void> = [];

/** 会话级回调注册：sessionId → { onEvent, onCreated, onError, resolvePrompt } */
interface SessionCallbacks {
  onEvent?: (event: any) => void;
  onCreated?: () => void;
  onError?: (message: string) => void;
  resolvePrompt?: () => void;
}
const sessionCallbacks = new Map<string, SessionCallbacks>();

/** 后端进程内调本机 API 的 base 地址（PORT 与 app 一致） */
function buildWorktimeApiBase(): string {
  const port = Number(process.env.PORT) || 3000;
  const base = (process.env.BASE_PATH || '').replace(/\/+$/, '');
  return `http://127.0.0.1:${port}${base}/api/v1`;
}

/** 启动 worker（服务启动时调用一次）。返回 ready promise，供预加载等待。 */
let workerReadyPromise: Promise<void> | null = null;
export function startWorker(): Promise<void> {
  if (workerReadyPromise) return workerReadyPromise;
  workerReadyPromise = new Promise<void>((resolve) => {
    worker = new Worker(WORKER_FILE);
    worker.on('message', (msg: any) => {
      if (msg.type === 'ready') {
        workerReady = true;
        logger.info('[ai] pi worker 就绪');
        // worker 重启后所有 session 回调失效，清空待解析的 create 请求
        workerReadyResolvers.forEach((r) => r());
        workerReadyResolvers = [];
        resolve();
      } else if (msg.type === 'created') {
        sessionCallbacks.get(msg.sessionId)?.onCreated?.();
      } else if (msg.type === 'event') {
        sessionCallbacks.get(msg.sessionId)?.onEvent?.(msg.payload);
      } else if (msg.type === 'prompt-done') {
        // worker 的一次 prompt 完成，resolve 对应的 promptSession Promise
        sessionCallbacks.get(msg.sessionId)?.resolvePrompt?.();
      } else if (msg.type === 'error') {
        logger.error({ msg, sessionId: msg.sessionId }, '[ai] worker 报错');
        sessionCallbacks.get(msg.sessionId)?.onError?.(msg.message);
        sessionCallbacks.get(msg.sessionId)?.resolvePrompt?.();
      }
    });
    worker.on('error', (err) => {
      logger.error({ err }, '[ai] worker 线程异常');
      workerReady = false;
    });
    worker.on('exit', (code) => {
      logger.warn({ code }, '[ai] worker 线程退出');
      workerReady = false;
      workerReadyPromise = null;
    });
  });
  return workerReadyPromise;
}

/**
 * 创建（或复用）一个 chat 会话。
 * 主线程取 PAT 后通过消息传给 worker，worker 在其线程内创建 pi session。
 */
export async function getOrCreateSession(
  userId: number,
  sessionId: string | undefined,
  callbacks: SessionCallbacks,
): Promise<{ sessionId: string; isNew: boolean }> {
  if (!aiReady) {
    throw new Error('AI 未配置（缺少 AI_API_KEY 或 provider 配置），请在服务端配置后重启');
  }
  if (!workerReady) {
    await startWorker();
  }

  // 复用已有会话：sessionId 已在 worker 里存在。
  // 必须更新 sessionCallbacks 为本次请求的回调（新请求有新的 SSE res / onEvent），
  // 否则事件会发到上一轮已关闭的连接。
  if (sessionId) {
    sessionCallbacks.set(sessionId, callbacks);
    return { sessionId, isNew: false };
  }

  const pat = await new PatService().getPlainForAgent(userId);
  const worktimeApi = buildWorktimeApiBase();
  const newSessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 等 worker 的 created 回执——worker 创建 session 是异步的（reload + createAgentSession），
  // 必须等创建完成才能 prompt，否则 prompt 发过去时 session 还没在 worker 里
  const created = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('创建会话超时（30s）')), 30000);
    sessionCallbacks.set(newSessionId, {
      ...callbacks,
      onCreated: () => { clearTimeout(timer); resolve(); },
      onError: (msg) => { clearTimeout(timer); reject(new Error(msg)); },
    });
  });

  worker!.postMessage({
    type: 'create',
    sessionId: newSessionId,
    userId,
    pat,
    worktimeApi,
    piModelsJsonPath,
    aiConfig: {
      piProviderName: aiConfig.piProviderName,
      apiKey: aiConfig.apiKey,
      modelId: aiConfig.modelId,
    },
  });

  await created;
  // created 后换回持久 callbacks（onEvent/onError/resolvePrompt），供后续 prompt 用
  sessionCallbacks.set(newSessionId, callbacks);
  return { sessionId: newSessionId, isNew: true };
}

/**
 * 发送一条消息并订阅事件流。事件通过 getOrCreateSession 注册的 onEvent 回调逐条返回。
 * 返回的 Promise 在 worker 完成本次 prompt（prompt-done 或 error）时 resolve。
 */
export function promptSession(sessionId: string, text: string): Promise<void> {
  if (!workerReady || !worker) {
    return Promise.reject(new Error('AI worker 未就绪'));
  }
  return new Promise<void>((resolve) => {
    const cb = sessionCallbacks.get(sessionId);
    if (cb) cb.resolvePrompt = resolve;
    else resolve(); // 会话不存在，直接 resolve（onError 已在 worker 侧触发）
    worker!.postMessage({ type: 'prompt', sessionId, message: text });
  });
}

/** AI 是否就绪（供路由层快速判断） */
export function isAiReady(): boolean {
  return aiReady;
}

/**
 * 服务启动时调用：预启动 worker 并 import pi，避免首次请求时才加载。
 */
export function preloadPi(): void {
  startWorker().catch((e) => {
    logger.error({ err: e }, '[ai] 预启动 worker 失败');
  });
}
