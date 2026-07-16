import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { BusinessError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  abortSession,
  deleteSession,
  getOrCreateSession,
  getSessionHistory,
  isAiReady,
  listSessions,
  promptSession,
  queueSessionMessage,
  regenerateSession,
  renameSession,
} from '../ai/agentRunner';

const router = Router();
router.use(authMiddleware);

function ensureAiReady() {
  if (!isAiReady()) {
    throw new BusinessError('AI 助手未配置，请联系管理员完成服务端配置', 503, 503);
  }
}

function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) {
    throw new BusinessError('会话标识无效');
  }
  return value.trim();
}

function parseMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new BusinessError('消息不能为空');
  const message = value.trim();
  if (message.length > 10000) throw new BusinessError('消息过长，请控制在 10000 字以内');
  return message;
}

function writeSse(res: Response, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  (res as any).flush?.();
}

router.get('/sessions', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessions = await listSessions(req.user!.id);
    res.json({ code: 0, data: sessions });
  } catch (error) {
    next(error);
  }
});

router.post('/sessions', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const result = await getOrCreateSession(req.user!.id, undefined, {});
    res.json({ code: 0, data: { id: result.sessionId, title: '新对话' } });
  } catch (error) {
    next(error);
  }
});

router.get('/sessions/:sessionId/messages', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    const messages = await getSessionHistory(req.user!.id, sessionId);
    res.json({ code: 0, data: messages });
  } catch (error) {
    next(error);
  }
});

router.patch('/sessions/:sessionId', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) throw new BusinessError('会话名称不能为空');
    if (title.length > 50) throw new BusinessError('会话名称不能超过 50 字');
    await renameSession(req.user!.id, sessionId, title);
    res.json({ code: 0, data: { id: sessionId, title } });
  } catch (error) {
    next(error);
  }
});

router.delete('/sessions/:sessionId', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    await deleteSession(req.user!.id, sessionId);
    res.json({ code: 0, message: '对话已删除' });
  } catch (error) {
    next(error);
  }
});

router.post('/sessions/:sessionId/abort', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    await abortSession(req.user!.id, sessionId);
    res.json({ code: 0, message: '已停止当前任务' });
  } catch (error) {
    next(error);
  }
});

router.post('/sessions/:sessionId/queue', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    const message = parseMessage(req.body?.message);
    const mode = req.body?.mode === 'steer' ? 'steer' : 'followUp';
    await queueSessionMessage(req.user!.id, sessionId, message, mode);
    res.json({ code: 0, data: { mode }, message: mode === 'steer' ? '已调整当前任务' : '消息已排队' });
  } catch (error) {
    next(error);
  }
});

/**
 * 流式聊天。兼容旧客户端的 sessionId 字段；未传时自动创建新会话。
 */
router.post('/chat', async (req: AuthRequest, res: Response, next) => {
  try {
    ensureAiReady();
  } catch (error) {
    return next(error);
  }

  let message: string;
  let requestedSessionId: string | undefined;
  let regenerate = false;
  try {
    message = parseMessage(req.body?.message);
    requestedSessionId = req.body?.sessionId ? parseSessionId(req.body.sessionId) : undefined;
    regenerate = req.body?.regenerate === true;
    if (regenerate && !requestedSessionId) throw new BusinessError('重新生成需要指定会话');
  } catch (error) {
    return next(error);
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let clientClosed = false;
  let streamCompleted = false;
  let activeSessionId: string | undefined;
  res.on('close', () => {
    clientClosed = true;
    if (!streamCompleted && activeSessionId) {
      abortSession(req.user!.id, activeSessionId).catch((error) => {
        logger.warn({ err: error, sessionId: activeSessionId }, '[agent] 客户端断开后停止会话失败');
      });
    }
  });

  writeSse(res, { type: 'meta', userId: req.user!.id });

  try {
    const result = await getOrCreateSession(req.user!.id, requestedSessionId, {
      onEvent: (event) => {
        if (!clientClosed) writeSse(res, event);
      },
      onError: (errorMessage) => {
        if (!clientClosed) writeSse(res, { type: 'error', message: errorMessage });
      },
    });
    activeSessionId = result.sessionId;
    writeSse(res, { type: 'session', sessionId: result.sessionId, isNew: result.isNew });
    if (regenerate) await regenerateSession(req.user!.id, result.sessionId, message);
    else await promptSession(req.user!.id, result.sessionId, message);

    if (!clientClosed) {
      streamCompleted = true;
      writeSse(res, { type: 'done', sessionId: result.sessionId });
      res.end();
    }
  } catch (error: any) {
    logger.error({ err: error }, '[agent] chat 处理失败');
    if (!clientClosed) {
      streamCompleted = true;
      writeSse(res, { type: 'error', message: error?.message || 'AI 处理失败' });
      res.end();
    }
  }
});

export const agentRoutes = router;
