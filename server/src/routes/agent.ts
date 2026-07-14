import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { BusinessError } from '../utils/errors';
import { logger } from '../utils/logger';
import { getOrCreateSession, promptSession, isAiReady } from '../ai/agentRunner';

const router = Router();

// 聊天端点走 JWT 会话鉴权（聊天不用 PAT，PAT 是给 skill 的 curl 用的）
router.use(authMiddleware);

/**
 * 把一条事件作为 SSE data 帧写出。
 * SSE 帧格式：`data: <单行JSON>\n\n`
 */
function writeSse(res: Response, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  // Express 的 res.write 不一定立即刷新到底层 socket（尤其经反向代理时），
  // 显式 flush 确保 SSE 帧及时送达客户端，避免前端长时间"思考中"。
  (res as any).flush?.();
}

/**
 * POST /agent/chat  —— 流式聊天（SSE）。
 *
 * 请求体：{ message: string, sessionId?: string }
 * 响应：text/event-stream，逐条推送 pi 事件（透传），末尾推一个 { type: 'done' } 收尾。
 *
 * 事件类型（前端按 type 处理）：
 * - message_start / message_update / message_end：助手消息（含流式文本增量）
 * - tool_execution_start / tool_execution_end：工具（skill 的 bash/curl）执行
 * - turn_end：本轮结束
 * - error：错误
 * - done：本次 SSE 流结束
 */
router.post('/chat', async (req: AuthRequest, res: Response, next) => {
  // AI 未配置时直接返回 503（不走 SSE，普通 JSON 错误）
  if (!isAiReady()) {
    return res.status(503).json({
      code: 503,
      message: 'AI 助手未配置，请联系管理员在服务端配置 AI_API_KEY 后重启服务',
    });
  }

  const { message, sessionId } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ code: 400, message: '消息不能为空' });
  }

  // 设置 SSE 响应头（关键：禁用压缩、禁用 buffering）
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 不缓冲
  res.flushHeaders?.();

  // 客户端断开时标记，避免继续写已关闭的连接
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  // 发送一个 meta 帧让前端知道流已建立
  writeSse(res, { type: 'meta', userId: req.user!.id });

  try {
    // 创建/复用会话：onEvent 把 pi 事件逐条转 SSE 推给前端
    const { sessionId: sid } = await getOrCreateSession(req.user!.id, sessionId, {
      onEvent: (event) => {
        if (clientClosed) return;
        try {
          writeSse(res, event);
        } catch (e) {
          logger.error({ err: e }, '[agent] SSE 写入失败');
        }
      },
      onError: (errMsg) => {
        if (clientClosed) return;
        try {
          writeSse(res, { type: 'error', message: errMsg });
        } catch { /* 连接已关 */ }
      },
    });
    writeSse(res, { type: 'session', sessionId: sid });

    // 发送消息；promptSession 在 worker 完成本次 turn 时 resolve
    await promptSession(sid, message);

    if (!clientClosed) {
      writeSse(res, { type: 'done', sessionId: sid });
      res.end();
    }
  } catch (e: any) {
    logger.error({ err: e }, '[agent] chat 处理失败');
    if (!clientClosed) {
      try {
        writeSse(res, { type: 'error', message: e?.message || 'AI 处理失败' });
        res.end();
      } catch {
        /* 连接已关 */
      }
    }
  }
});

export const agentRoutes = router;
