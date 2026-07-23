import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createRouteTestApp } from '../helpers/http';
import { logger } from '@server/utils/logger';

const runner = vi.hoisted(() => ({
  abortSession: vi.fn(),
  checkAiAvailability: vi.fn(),
  deleteSession: vi.fn(),
  getOrCreateSession: vi.fn(),
  getSessionHistory: vi.fn(),
  isAiReady: vi.fn(),
  listSessions: vi.fn(),
  promptSession: vi.fn(),
  queueSessionMessage: vi.fn(),
  regenerateSession: vi.fn(),
  releaseSessionCallbacks: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock('@server/ai/agentRunner', () => runner);
vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 7, username: 'ai-user', realName: 'AI 用户', roles: ['employee'] };
    next();
  },
}));

const { agentRoutes, sanitizeAgentEvent } = await import('@server/routes/agent');
const app = createRouteTestApp('/agent', agentRoutes);

describe('AI 助手路由契约', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runner.isAiReady.mockReturnValue(true);
    runner.checkAiAvailability.mockResolvedValue(true);
    runner.abortSession.mockResolvedValue(undefined);
    runner.queueSessionMessage.mockResolvedValue(undefined);
    runner.releaseSessionCallbacks.mockReturnValue(undefined);
  });

  it('SSE 事件在出服务端前移除原始推理、未知参数和内部错误', () => {
    expect(sanitizeAgentEvent({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '不应发送的原始推理' },
          { type: 'text', text: '可展示答案' },
        ],
        internal: 'secret',
      },
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, delta: '原始推理增量' },
      providerPayload: { apiKey: 'secret' },
    })).toEqual({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '可展示答案' },
        ],
      },
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 },
    });

    expect(sanitizeAgentEvent({
      type: 'tool_execution_start',
      toolName: 'worktime_query',
      toolCallId: 'tool-1',
      args: {
        resource: 'weekly_timesheet_summary',
        weekStart: '2026-07-20',
        weekEnd: '2026-07-26',
        secret: 'hidden',
      },
    })).toMatchObject({
      args: {
        resource: 'weekly_timesheet_summary',
        weekStart: '2026-07-20',
        weekEnd: '2026-07-26',
      },
    });
    expect(sanitizeAgentEvent({ type: 'error', message: 'POST https://private-llm failed' }))
      .toEqual({ type: 'error', message: 'AI 处理失败，请稍后重试' });
  });

  it('状态接口在未配置 AI 时仍正常返回，其他接口明确返回 503', async () => {
    runner.isAiReady.mockReturnValue(false);
    runner.checkAiAvailability.mockResolvedValue(false);

    const status = await request(app).get('/agent/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({ enabled: false });

    const sessions = await request(app).get('/agent/sessions');
    expect(sessions.status).toBe(503);
    expect(sessions.body.message).toContain('AI 助手未配置');
    expect(runner.listSessions).not.toHaveBeenCalled();
  });

  it('严格拒绝未知排队模式，不静默降级成 followUp', async () => {
    const response = await request(app).post('/agent/sessions/session-1/queue').send({
      message: '继续查询',
      mode: 'invalid-mode',
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('消息排队模式无效');
    expect(runner.queueSessionMessage).not.toHaveBeenCalled();
  });

  it('限制消息长度并在进入 Worker 前完成校验', async () => {
    const response = await request(app).post('/agent/chat').send({ message: 'x'.repeat(10001) });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('10000');
    expect(runner.getOrCreateSession).not.toHaveBeenCalled();
  });

  it('将会话类可操作错误映射为明确状态码，而不是服务器内部错误', async () => {
    runner.getSessionHistory.mockRejectedValueOnce(new Error('会话不存在'));
    const missing = await request(app).get('/agent/sessions/missing/messages');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('会话不存在');

    runner.getOrCreateSession.mockRejectedValueOnce(new Error('最多保留30条对话，请先删除不需要的历史对话'));
    const quota = await request(app).post('/agent/sessions');
    expect(quota.status).toBe(400);
    expect(quota.body.message).toContain('最多保留30条');

    runner.queueSessionMessage.mockRejectedValueOnce(new Error('当前会话没有正在执行的任务'));
    const conflict = await request(app).post('/agent/sessions/session-1/queue').send({ message: '继续' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toBe('当前会话没有正在执行的任务');
  });

  it('Worker 请求失败时 SSE 只发送一帧脱敏错误并释放会话回调', async () => {
    runner.getOrCreateSession.mockResolvedValue({ sessionId: 'session-1', isNew: false });
    runner.promptSession.mockRejectedValue(new Error('上游模型失败'));

    const response = await request(app).post('/agent/chat').send({
      sessionId: 'session-1',
      message: '查询本周工时',
    });

    expect(response.status).toBe(200);
    expect((response.text.match(/"type":"error"/g) || [])).toHaveLength(1);
    expect(response.text).toContain('AI 处理失败，请稍后重试');
    expect(response.text).not.toContain('上游模型失败');
    expect(runner.releaseSessionCallbacks).toHaveBeenCalledWith(7, 'session-1');
  });

  it('保留安全可操作的繁忙提示，不向用户泄露上游内部错误', async () => {
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    runner.getOrCreateSession.mockResolvedValue({ sessionId: 'session-1', isNew: false });
    runner.promptSession.mockRejectedValueOnce(new Error('AI 服务当前任务较多，请稍后重试'));
    const busy = await request(app).post('/agent/chat').send({ sessionId: 'session-1', message: '查询' });
    expect(busy.text).toContain('AI 服务当前任务较多，请稍后重试');

    runner.promptSession.mockRejectedValueOnce(new Error('POST https://private-llm.example failed with secret detail'));
    const internal = await request(app).post('/agent/chat').send({ sessionId: 'session-1', message: '查询' });
    expect(internal.text).toContain('AI 处理失败，请稍后重试');
    expect(internal.text).not.toContain('private-llm.example');
    expect(logError).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: 7,
      sessionId: 'session-1',
      errorCategory: 'AI 处理失败，请稍后重试',
    }), '[agent] chat 处理失败');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('private-llm.example');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret detail');
  });

  it('会话列表、创建和历史记录始终绑定当前用户', async () => {
    runner.listSessions.mockResolvedValue([{ id: 'session-1', title: '历史' }]);
    runner.getOrCreateSession.mockResolvedValue({ sessionId: 'session-2', isNew: true });
    runner.getSessionHistory.mockResolvedValue([{ role: 'user', content: '问题' }]);

    expect((await request(app).get('/agent/sessions')).body.data).toEqual([{ id: 'session-1', title: '历史' }]);
    expect(runner.listSessions).toHaveBeenCalledWith(7);
    const created = await request(app).post('/agent/sessions');
    expect(created.body.data).toEqual({ id: 'session-2', title: '新对话' });
    expect(runner.getOrCreateSession).toHaveBeenCalledWith(7, undefined, {});
    expect((await request(app).get('/agent/sessions/session-1/messages')).status).toBe(200);
    expect(runner.getSessionHistory).toHaveBeenCalledWith(7, 'session-1');
  });

  it('重命名、删除和停止会话校验标识与名称后再调用 Worker', async () => {
    runner.renameSession.mockResolvedValue(undefined);
    runner.deleteSession.mockResolvedValue(undefined);
    runner.abortSession.mockResolvedValue(undefined);

    expect((await request(app).patch('/agent/sessions/session-1').send({ title: '  新名称  ' })).status).toBe(200);
    expect(runner.renameSession).toHaveBeenCalledWith(7, 'session-1', '新名称');
    expect((await request(app).patch('/agent/sessions/session-1').send({ title: 'x'.repeat(51) })).status).toBe(400);
    expect(runner.renameSession).toHaveBeenCalledTimes(1);

    expect((await request(app).delete('/agent/sessions/session-1')).status).toBe(200);
    expect(runner.deleteSession).toHaveBeenCalledWith(7, 'session-1');
    expect((await request(app).post('/agent/sessions/session-1/abort')).status).toBe(200);
    expect(runner.abortSession).toHaveBeenCalledWith(7, 'session-1');
  });

  it('排队消息规范化文本并明确区分调整和后续模式', async () => {
    const steer = await request(app).post('/agent/sessions/session-1/queue').send({
      message: '  改为查询本月  ', mode: 'steer',
    });
    expect(steer.status).toBe(200);
    expect(steer.body.data.mode).toBe('steer');
    expect(runner.queueSessionMessage).toHaveBeenCalledWith(7, 'session-1', '改为查询本月', 'steer');

    const followUp = await request(app).post('/agent/sessions/session-1/queue').send({ message: '继续' });
    expect(followUp.body.data.mode).toBe('followUp');
    expect(runner.queueSessionMessage).toHaveBeenCalledWith(7, 'session-1', '继续', 'followUp');
  });

  it('聊天成功只输出白名单事件，完成后释放回调', async () => {
    runner.getOrCreateSession.mockImplementation(async (_userId: number, _sessionId: string, callbacks: any) => {
      callbacks.onEvent({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: '结果' }] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1 },
        internal: 'secret',
      });
      callbacks.onEvent({ type: 'unknown_sdk_event', secret: 'hidden' });
      return { sessionId: 'session-1', isNew: false };
    });
    runner.promptSession.mockResolvedValue(undefined);
    const response = await request(app).post('/agent/chat').send({ sessionId: 'session-1', message: ' 查询 ' });
    expect(response.status).toBe(200);
    expect(response.text).toContain('"type":"done"');
    expect(response.text).toContain('结果');
    expect(response.text).not.toContain('secret');
    expect(response.text).not.toContain('unknown_sdk_event');
    expect(runner.promptSession).toHaveBeenCalledWith(7, 'session-1', '查询');
    expect(runner.releaseSessionCallbacks).toHaveBeenCalledWith(7, 'session-1');
  });

  it('重新生成必须指定会话，并调用独立的重新生成入口', async () => {
    const invalid = await request(app).post('/agent/chat').send({ message: '重新回答', regenerate: true });
    expect(invalid.status).toBe(400);
    expect(runner.getOrCreateSession).not.toHaveBeenCalled();

    runner.getOrCreateSession.mockResolvedValue({ sessionId: 'session-1', isNew: false });
    runner.regenerateSession.mockResolvedValue(undefined);
    const response = await request(app).post('/agent/chat').send({
      sessionId: 'session-1', message: '重新回答', regenerate: true,
    });
    expect(response.status).toBe(200);
    expect(runner.regenerateSession).toHaveBeenCalledWith(7, 'session-1', '重新回答');
    expect(runner.promptSession).not.toHaveBeenCalled();
  });
});
