import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { BusinessError, isBusinessError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  abortSession,
  checkAiAvailability,
  deleteSession,
  getOrCreateSession,
  getSessionHistory,
  isAiReady,
  listSessions,
  promptSession,
  queueSessionMessage,
  regenerateSession,
  releaseSessionCallbacks,
  renameSession,
} from '../ai/agentRunner';

const router = Router();
router.use(authMiddleware);

// 前端据此决定是否展示 AI 入口；未配置时不必先触发一个 503 才知道不可用。
router.get('/status', async (_req: AuthRequest, res) => {
  res.json({ code: 0, data: { enabled: await checkAiAvailability() } });
});

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

export function presentAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const safeMessages = [
    /^会话不存在$/,
    /^当前会话正在处理中$/,
    /^当前会话没有正在执行的任务$/,
    /^该会话已在其他窗口处理中$/,
    /^任务已取消$/,
    /^没有可重新生成的消息$/,
    /^重新生成已取消$/,
    /^最多保留\d+条对话，请先删除不需要的历史对话$/,
    /^AI 服务当前任务较多，请稍后重试$/,
  ];
  if (safeMessages.some(pattern => pattern.test(message))) return message;
  if (/超时|timeout/i.test(message)) return 'AI 处理超时，请稍后重试';
  if (/429|rate.?limit|too many requests|限流|频繁/i.test(message)) return 'AI 模型服务繁忙，请稍后重试';
  if (/找不到模型|pi 加载失败|模型配置/i.test(message)) return 'AI 模型配置不可用，请联系管理员';
  return 'AI 处理失败，请稍后重试';
}

const toolArgumentKeys = new Set([
  'resource', 'startDate', 'endDate', 'status', 'weekStart', 'page', 'pageSize', 'userId', 'includeAll',
]);

/** 只把聊天 UI 必需字段送出进程；原始推理、堆栈和 SDK 内部元数据不得进入浏览器。 */
export function sanitizeAgentEvent(event: any): any | null {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
  if (event.type === 'error') {
    return { type: 'error', message: presentAgentError(new Error(String(event.message || ''))) };
  }
  if (event.type === 'message_start' || event.type === 'message_update') {
    const role = event.message?.role;
    if (role !== 'assistant') return null;
    const subtype = typeof event.assistantMessageEvent?.type === 'string'
      ? event.assistantMessageEvent.type
      : '';
    if (!subtype.startsWith('text_') && !subtype.startsWith('thinking_')) return null;
    const rawContent = event.message?.content;
    const content: any = typeof rawContent === 'string'
      ? (subtype.startsWith('text_') ? rawContent : '')
      : Array.isArray(rawContent)
        ? rawContent.reduce((parts: any[], part: any) => {
          if (part?.type === 'text') parts.push({ type: 'text', text: String(part.text || '') });
          if (part?.type === 'thinking') parts.push({ type: 'thinking', thinking: '' });
          return parts;
        }, [])
        : [];
    return {
      type: event.type,
      message: { role: 'assistant', content },
      assistantMessageEvent: {
        type: subtype,
        contentIndex: Number.isInteger(event.assistantMessageEvent?.contentIndex)
          ? event.assistantMessageEvent.contentIndex
          : undefined,
      },
    };
  }
  if (event.type === 'tool_execution_start') {
    const args = Object.fromEntries(
      Object.entries(event.args || {}).filter(([key]) => toolArgumentKeys.has(key)),
    );
    return {
      type: 'tool_execution_start',
      toolName: event.toolName === 'worktime_query' ? 'worktime_query' : 'tool',
      toolCallId: String(event.toolCallId || ''),
      args,
    };
  }
  if (event.type === 'tool_execution_end') {
    const text = Array.isArray(event.result?.content)
      ? event.result.content
        .filter((item: any) => item?.type === 'text')
        .map((item: any) => String(item.text || ''))
        .join('\n')
        .slice(0, 20_000)
      : '';
    return {
      type: 'tool_execution_end',
      toolCallId: String(event.toolCallId || ''),
      isError: !!event.isError,
      result: {
        content: [{ type: 'text', text: event.isError ? '查询执行失败' : text }],
      },
    };
  }
  return null;
}

function toAgentHttpError(error: unknown): unknown {
  if (isBusinessError(error)) return error;
  const message = presentAgentError(error);
  if (message === '会话不存在') return new BusinessError(message, 404, 404);
  if (/^最多保留\d+条对话/.test(message)) return new BusinessError(message, 400, 400);
  if (message === 'AI 服务当前任务较多，请稍后重试') return new BusinessError(message, 429, 429);
  if (message === 'AI 处理超时，请稍后重试') return new BusinessError(message, 504, 504);
  if (message === 'AI 模型配置不可用，请联系管理员') return new BusinessError(message, 503, 503);
  if ([
    '当前会话正在处理中',
    '当前会话没有正在执行的任务',
    '该会话已在其他窗口处理中',
    '任务已取消',
    '没有可重新生成的消息',
    '重新生成已取消',
  ].includes(message)) return new BusinessError(message, 409, 409);
  return error;
}

router.get('/sessions', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessions = await listSessions(req.user!.id);
    res.json({ code: 0, data: sessions });
  } catch (error) {
    next(toAgentHttpError(error));
  }
});

router.post('/sessions', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const result = await getOrCreateSession(req.user!.id, undefined, {});
    res.json({ code: 0, data: { id: result.sessionId, title: '新对话' } });
  } catch (error) {
    next(toAgentHttpError(error));
  }
});

router.get('/sessions/:sessionId/messages', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    const messages = await getSessionHistory(req.user!.id, sessionId);
    res.json({ code: 0, data: messages });
  } catch (error) {
    next(toAgentHttpError(error));
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
    next(toAgentHttpError(error));
  }
});

router.delete('/sessions/:sessionId', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    await deleteSession(req.user!.id, sessionId);
    res.json({ code: 0, message: '对话已删除' });
  } catch (error) {
    next(toAgentHttpError(error));
  }
});

router.post('/sessions/:sessionId/abort', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    await abortSession(req.user!.id, sessionId);
    res.json({ code: 0, message: '已停止当前任务' });
  } catch (error) {
    next(toAgentHttpError(error));
  }
});

router.post('/sessions/:sessionId/queue', async (req: AuthRequest, res, next) => {
  try {
    ensureAiReady();
    const sessionId = parseSessionId(req.params.sessionId);
    const message = parseMessage(req.body?.message);
    const rawMode = req.body?.mode;
    if (rawMode !== undefined && rawMode !== 'steer' && rawMode !== 'followUp') {
      throw new BusinessError('消息排队模式无效');
    }
    const mode = rawMode === 'steer' ? 'steer' : 'followUp';
    await queueSessionMessage(req.user!.id, sessionId, message, mode);
    res.json({ code: 0, data: { mode }, message: mode === 'steer' ? '已调整当前任务' : '消息已排队' });
  } catch (error) {
    next(toAgentHttpError(error));
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
  const heartbeat = setInterval(() => {
    if (!clientClosed && !res.writableEnded) res.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();
  res.on('close', () => {
    clientClosed = true;
    clearInterval(heartbeat);
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
        const safeEvent = sanitizeAgentEvent(event);
        if (!clientClosed && safeEvent) writeSse(res, safeEvent);
      },
      onError: (errorMessage) => {
        if (!clientClosed) writeSse(res, { type: 'error', message: presentAgentError(new Error(errorMessage)) });
      },
    });
    activeSessionId = result.sessionId;
    if (clientClosed) {
      await abortSession(req.user!.id, result.sessionId).catch(() => undefined);
      return;
    }
    writeSse(res, { type: 'session', sessionId: result.sessionId, isNew: result.isNew });
    if (regenerate) await regenerateSession(req.user!.id, result.sessionId, message);
    else await promptSession(req.user!.id, result.sessionId, message);

    if (!clientClosed) {
      streamCompleted = true;
      writeSse(res, { type: 'done', sessionId: result.sessionId });
      res.end();
    }
  } catch (error: any) {
    // 上游 SDK 错误可能包含私有 endpoint、请求摘要甚至凭据片段；日志与 SSE 使用同一安全分类，
    // 仅保留用户、会话和可操作错误类别，避免“客户端已脱敏、日志仍泄露”。
    logger.error({
      userId: req.user!.id,
      sessionId: activeSessionId,
      errorCategory: presentAgentError(error),
    }, '[agent] chat 处理失败');
    if (!clientClosed) {
      streamCompleted = true;
      writeSse(res, { type: 'error', message: presentAgentError(error) });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    if (activeSessionId) releaseSessionCallbacks(req.user!.id, activeSessionId);
  }
});

export const agentRoutes = router;
