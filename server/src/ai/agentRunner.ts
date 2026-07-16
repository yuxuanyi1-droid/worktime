import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import path from 'node:path';
import { logger } from '../utils/logger';
import { aiConfig, aiReady, piModelsJsonPath } from '../config/ai';
import { PatService } from '../services/patService';

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
const pendingRequests = new Map<string, PendingRequest>();
const sessionCallbacks = new Map<string, SessionCallbacks>();
const sessionOwners = new Map<string, number>();

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
  workerReadyPromise = new Promise<void>((resolve, reject) => {
    worker = new Worker(WORKER_FILE);
    worker.on('message', (message: any) => {
      if (message.type === 'ready') {
        workerReady = true;
        logger.info('[ai] pi worker 就绪');
        resolve();
        return;
      }
      if (message.type === 'error' && !message.requestId && !message.sessionId && !workerReady) {
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
      if (message.type === 'error' && message.sessionId) {
        sessionCallbacks.get(message.sessionId)?.onError?.(message.message);
      }
      if (!settleRequest(message) && message.type === 'error') {
        logger.error({ message }, '[ai] worker 报错');
      }
    });
    worker.on('error', (error) => {
      logger.error({ err: error }, '[ai] worker 线程异常');
      workerReady = false;
      rejectAllPending(error);
      reject(error);
    });
    worker.on('exit', (code) => {
      logger.warn({ code }, '[ai] worker 线程退出');
      workerReady = false;
      workerReadyPromise = null;
      sessionOwners.clear();
      sessionCallbacks.clear();
      rejectAllPending(new Error('AI worker 已退出'));
    });
  });
  return workerReadyPromise;
}

async function requestWorker(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
  if (!aiReady) throw new Error('AI 未配置，请联系管理员完成服务端配置');
  if (!workerReady) await startWorker();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Agent 操作超时'));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
    worker!.postMessage({ type, requestId, ...payload });
  });
}

async function openSession(userId: number, sessionId?: string): Promise<string> {
  const pat = await new PatService().getPlainForAgent(userId);
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
  return response.sessionId;
}

async function ensureOwnedSession(userId: number, sessionId: string): Promise<string> {
  const owner = sessionOwners.get(sessionId);
  if (owner !== undefined) {
    if (owner !== userId) throw new Error('会话不存在');
    return sessionId;
  }
  return openSession(userId, sessionId);
}

export async function getOrCreateSession(
  userId: number,
  sessionId: string | undefined,
  callbacks: SessionCallbacks,
): Promise<{ sessionId: string; isNew: boolean }> {
  const sid = sessionId ? await ensureOwnedSession(userId, sessionId) : await openSession(userId);
  sessionCallbacks.set(sid, callbacks);
  return { sessionId: sid, isNew: !sessionId };
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
  await requestWorker('prompt', { userId, sessionId: sid, message: text }, 10 * 60 * 1000);
}

export async function regenerateSession(userId: number, sessionId: string, text: string): Promise<void> {
  const sid = await ensureOwnedSession(userId, sessionId);
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
}

export function isAiReady(): boolean {
  return aiReady;
}

export function preloadPi(): void {
  startWorker().catch((error) => {
    logger.error({ err: error }, '[ai] 预启动 worker 失败');
  });
}
