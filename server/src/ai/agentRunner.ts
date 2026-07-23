import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import path from 'node:path';
import { logger } from '../utils/logger';
import { aiConfig, isAiRuntimeReady, piModelsJsonPath } from '../config/ai';
import { AuthService } from '../services/authService';
import { resetAiWorkerStats, setAiWorkerStats } from '../middleware/metrics';

const WORKER_FILE = ((): string => {
  const base = path.resolve(__dirname, 'agentWorker');
  const fs = require('fs');
  return fs.existsSync(base + '.ts') ? base + '.ts' : base + '.js';
})();

interface SessionCallbacks {
  onEvent?: (event: any) => void;
  onError?: (message: string) => void;
}

interface PendingRequest {
  resolve: (message: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

let worker: Worker | null = null;
let workerReady = false;
let workerReadyPromise: Promise<void> | null = null;
let workerStopping = false;
const pendingRequests = new Map<string, PendingRequest>();
const sessionCallbacks = new Map<string, SessionCallbacks>();
const sessionOwners = new Map<string, number>();
const openingSessions = new Map<string, Promise<string>>();
const sessionTokenRefreshAt = new Map<string, number>();
const AGENT_TOKEN_REFRESH_INTERVAL_MS = 90 * 60 * 1000;

function buildWorktimeApiBase(): string {
  const port = Number(process.env.PORT) || 3000;
  const base = (process.env.BASE_PATH || '').replace(/\/+$/, '');
  return `http://127.0.0.1:${port}${base}/api/v1`;
}

function settleRequest(message: any): boolean {
  if (!message.requestId) return false;
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRequests.delete(message.requestId);
  if (message.type === 'error') pending.reject(new Error(message.message || 'Agent 操作失败'));
  else pending.resolve(message);
  return true;
}

function rejectAllPending(error: Error) {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingRequests.clear();
}

export function startWorker(): Promise<void> {
  if (workerReadyPromise) return workerReadyPromise;
  workerStopping = false;
  workerReadyPromise = new Promise<void>((resolve, reject) => {
    let startupTimer: NodeJS.Timeout | undefined;
    const clearStartupTimer = () => {
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = undefined;
    };
    try {
      worker = new Worker(WORKER_FILE);
    } catch (error) {
      queueMicrotask(() => { workerReadyPromise = null; });
      reject(error);
      return;
    }
    startupTimer = setTimeout(() => {
      const error = new Error('AI worker 启动超时');
      logger.error({ err: error }, '[ai] worker 启动失败');
      reject(error);
      worker?.terminate().catch(() => undefined);
    }, 45_000);
    startupTimer.unref();
    worker.on('message', (message: any) => {
      if (message.type === 'ready') {
        clearStartupTimer();
        workerReady = true;
        logger.info('[ai] pi worker 就绪');
        resolve();
        return;
      }
      if (message.type === 'stats') {
        setAiWorkerStats(message.stats || {});
        return;
      }
      if (message.type === 'error' && !message.requestId && !message.sessionId && !workerReady) {
        clearStartupTimer();
        const error = new Error(message.message || 'pi worker 启动失败');
        logger.error({ err: error }, '[ai] worker 启动失败');
        reject(error);
        worker?.terminate().catch(() => undefined);
        return;
      }
      if (message.type === 'event') {
        sessionCallbacks.get(message.sessionId)?.onEvent?.(message.payload);
        return;
      }
      // 带 requestId 的错误由对应请求统一 reject，最终只由 HTTP/SSE 路由写出一次。
      // 否则既触发 onError 又 reject，会向客户端重复发送两帧相同错误。
      if (settleRequest(message)) return;
      if (message.type === 'error' && message.sessionId) {
        sessionCallbacks.get(message.sessionId)?.onError?.(message.message);
      }
      if (message.type === 'error') {
        logger.error({ message }, '[ai] worker 报错');
      }
    });
    worker.on('error', (error) => {
      clearStartupTimer();
      logger.error({ err: error }, '[ai] worker 线程异常');
      workerReady = false;
      rejectAllPending(error);
      reject(error);
    });
    worker.on('exit', (code) => {
      clearStartupTimer();
      if (workerStopping) logger.info('[ai] worker 已停止');
      else logger.warn({ code }, '[ai] worker 线程退出');
      workerStopping = false;
      worker = null;
      workerReady = false;
      workerReadyPromise = null;
      sessionOwners.clear();
      sessionCallbacks.clear();
      sessionTokenRefreshAt.clear();
      resetAiWorkerStats();
      rejectAllPending(new Error('AI worker 已退出'));
    });
  });
  return workerReadyPromise;
}

async function requestWorker(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
  if (!isAiRuntimeReady()) throw new Error('AI 未配置，请联系管理员完成服务端配置');
  if (!workerReady) await startWorker();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      if ((type === 'prompt' || type === 'regenerate') && typeof payload.sessionId === 'string') {
        worker?.postMessage({
          type: 'abort',
          requestId: crypto.randomUUID(),
          userId: payload.userId,
          sessionId: payload.sessionId,
        });
      }
      reject(new Error('Agent 操作超时'));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
    worker!.postMessage({ type, requestId, ...payload });
  });
}

async function openSession(userId: number, sessionId?: string): Promise<string> {
  const pat = await new AuthService().issueAgentAccessToken(userId);
  const response = await requestWorker('create', {
    userId,
    sessionId,
    pat,
    worktimeApi: buildWorktimeApiBase(),
    piModelsJsonPath,
    aiConfig: {
      piProviderName: aiConfig.piProviderName,
      apiKey: aiConfig.apiKey,
      modelId: aiConfig.modelId,
    },
  }, 45000);
  sessionOwners.set(response.sessionId, userId);
  sessionTokenRefreshAt.set(response.sessionId, Date.now() + AGENT_TOKEN_REFRESH_INTERVAL_MS);
  return response.sessionId;
}

async function refreshAccessTokenIfNeeded(userId: number, sessionId: string): Promise<void> {
  if ((sessionTokenRefreshAt.get(sessionId) ?? 0) > Date.now()) return;
  const pat = await new AuthService().issueAgentAccessToken(userId);
  await requestWorker('refresh-token', { userId, sessionId, pat });
  sessionTokenRefreshAt.set(sessionId, Date.now() + AGENT_TOKEN_REFRESH_INTERVAL_MS);
}

async function ensureOwnedSession(userId: number, sessionId: string): Promise<string> {
  const owner = sessionOwners.get(sessionId);
  if (owner !== undefined) {
    if (owner !== userId) throw new Error('会话不存在');
    return sessionId;
  }
  const key = `${userId}:${sessionId}`;
  const inFlight = openingSessions.get(key);
  if (inFlight) return inFlight;
  const opening = openSession(userId, sessionId).finally(() => openingSessions.delete(key));
  openingSessions.set(key, opening);
  return opening;
}

export async function getOrCreateSession(
  userId: number,
  sessionId: string | undefined,
  callbacks: SessionCallbacks,
): Promise<{ sessionId: string; isNew: boolean }> {
  const sid = sessionId ? await ensureOwnedSession(userId, sessionId) : await openSession(userId);
  if (callbacks.onEvent || callbacks.onError) {
    if (sessionCallbacks.has(sid)) throw new Error('该会话已在其他窗口处理中');
    sessionCallbacks.set(sid, callbacks);
  }
  return { sessionId: sid, isNew: !sessionId };
}

/** SSE 请求结束后立即释放 Response 回调，避免会话驻留期间持有已关闭连接。 */
export function releaseSessionCallbacks(userId: number, sessionId: string): void {
  if (sessionOwners.get(sessionId) === userId) sessionCallbacks.delete(sessionId);
}

export async function listSessions(userId: number): Promise<AgentSessionSummary[]> {
  const response = await requestWorker('list', { userId });
  return response.sessions;
}

export async function getSessionHistory(userId: number, sessionId: string): Promise<any[]> {
  const sid = await ensureOwnedSession(userId, sessionId);
  const response = await requestWorker('history', { userId, sessionId: sid });
  return response.messages;
}

export async function promptSession(userId: number, sessionId: string, text: string): Promise<void> {
  const sid = await ensureOwnedSession(userId, sessionId);
  await refreshAccessTokenIfNeeded(userId, sid);
  await requestWorker('prompt', { userId, sessionId: sid, message: text }, 10 * 60 * 1000);
}

export async function regenerateSession(userId: number, sessionId: string, text: string): Promise<void> {
  const sid = await ensureOwnedSession(userId, sessionId);
  await refreshAccessTokenIfNeeded(userId, sid);
  await requestWorker('regenerate', { userId, sessionId: sid, message: text }, 10 * 60 * 1000);
}

export async function queueSessionMessage(
  userId: number,
  sessionId: string,
  text: string,
  mode: 'steer' | 'followUp' = 'followUp',
): Promise<void> {
  const sid = await ensureOwnedSession(userId, sessionId);
  await requestWorker('queue', { userId, sessionId: sid, message: text, mode });
}

export async function abortSession(userId: number, sessionId: string): Promise<void> {
  const sid = await ensureOwnedSession(userId, sessionId);
  await requestWorker('abort', { userId, sessionId: sid });
}

export async function renameSession(userId: number, sessionId: string, title: string): Promise<void> {
  const sid = await ensureOwnedSession(userId, sessionId);
  await requestWorker('rename', { userId, sessionId: sid, title });
}

export async function deleteSession(userId: number, sessionId: string): Promise<void> {
  await ensureOwnedSession(userId, sessionId);
  await requestWorker('delete', { userId, sessionId });
  sessionOwners.delete(sessionId);
  sessionCallbacks.delete(sessionId);
  sessionTokenRefreshAt.delete(sessionId);
}

export function isAiReady(): boolean {
  return isAiRuntimeReady();
}

/** 状态接口使用真实 Worker 启动结果，避免配置存在但运行时不可用时展示入口。 */
export async function checkAiAvailability(): Promise<boolean> {
  if (!isAiRuntimeReady()) return false;
  try {
    await startWorker();
    return true;
  } catch {
    return false;
  }
}

export function preloadPi(): void {
  if (!isAiRuntimeReady()) return;
  startWorker().catch((error) => {
    logger.error({ err: error }, '[ai] 预启动 worker 失败');
  });
}

/**
 * 优雅退出时终止 pi worker，释放会话文件、订阅回调和待处理请求。
 * HTTP 连接应先完成 drain，再调用本函数，避免主动截断仍在输出的 SSE。
 */
export async function stopAgentWorker(): Promise<void> {
  const activeWorker = worker;
  worker = null;
  workerReady = false;
  workerReadyPromise = null;
  sessionOwners.clear();
  sessionCallbacks.clear();
  openingSessions.clear();
  sessionTokenRefreshAt.clear();
  rejectAllPending(new Error('AI worker 已停止'));
  resetAiWorkerStats();
  if (activeWorker) {
    workerStopping = true;
    await activeWorker.terminate();
  }
}
