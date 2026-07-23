import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  issueToken: vi.fn(async (userId: number) => `agent-token-${userId}`),
  instances: [] as any[],
}));

class FakeWorker extends EventEmitter {
  posted: any[] = [];
  terminated = false;

  constructor(public filename: string) {
    super();
    mocks.instances.push(this);
  }

  postMessage(message: any) {
    this.posted.push(message);
    queueMicrotask(() => {
      const base = { requestId: message.requestId };
      if (message.type === 'create') {
        this.emit('message', { ...base, type: 'created', sessionId: message.sessionId || 'session-1' });
      } else if (message.type === 'list') {
        this.emit('message', { ...base, type: 'sessions', sessions: [{ id: 'session-1' }] });
      } else if (message.type === 'history') {
        this.emit('message', { ...base, type: 'history', messages: [{ role: 'user' }] });
      } else if (message.type === 'prompt') {
        this.emit('message', { type: 'event', sessionId: message.sessionId, payload: { type: 'text', text: '回答' } });
        this.emit('message', { ...base, type: 'prompt-done', sessionId: message.sessionId });
      } else {
        this.emit('message', { ...base, type: 'action-done' });
      }
    });
  }

  async terminate() {
    this.terminated = true;
    this.emit('exit', 0);
    return 0;
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));
vi.mock('@server/config/ai', () => ({
  isAiRuntimeReady: () => true,
  piModelsJsonPath: '/tmp/models.json',
  aiConfig: { piProviderName: 'test', apiKey: 'secret', modelId: 'model' },
}));
vi.mock('@server/services/authService', () => ({
  AuthService: class {
    issueAgentAccessToken = mocks.issueToken;
  },
}));

const runner = await import('@server/ai/agentRunner');

afterEach(async () => {
  await runner.stopAgentWorker();
  mocks.instances.length = 0;
  mocks.issueToken.mockClear();
});

async function readyWorker() {
  const starting = runner.startWorker();
  const worker = mocks.instances.at(-1) as FakeWorker;
  worker.emit('message', { type: 'ready' });
  await starting;
  return worker;
}

describe('agentRunner', () => {
  it('Worker 未能就绪时状态检查在超时后关闭入口', async () => {
    vi.useFakeTimers();
    try {
      const availability = runner.checkAiAvailability();
      const worker = mocks.instances.at(-1) as FakeWorker;
      await vi.advanceTimersByTimeAsync(45_000);

      await expect(availability).resolves.toBe(false);
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('单例启动 Worker，打开会话时签发短期令牌且不向客户端暴露', async () => {
    const worker = await readyWorker();
    await expect(runner.startWorker()).resolves.toBeUndefined();
    expect(mocks.instances).toHaveLength(1);

    const result = await runner.getOrCreateSession(7, undefined, {});

    expect(result).toEqual({ sessionId: 'session-1', isNew: true });
    expect(mocks.issueToken).toHaveBeenCalledWith(7);
    expect(worker.posted[0]).toMatchObject({
      type: 'create',
      userId: 7,
      pat: 'agent-token-7',
      piModelsJsonPath: '/tmp/models.json',
    });
  });

  it('维护会话归属，阻止其他用户读取同一会话', async () => {
    await readyWorker();
    await runner.getOrCreateSession(7, undefined, {});

    await expect(runner.getSessionHistory(7, 'session-1')).resolves.toEqual([{ role: 'user' }]);
    await expect(runner.getSessionHistory(8, 'session-1')).rejects.toThrow('会话不存在');
  });

  it('流式事件只发送给当前回调，释放后不再持有已关闭连接', async () => {
    const worker = await readyWorker();
    const onEvent = vi.fn();
    await runner.getOrCreateSession(7, undefined, { onEvent });

    await runner.promptSession(7, 'session-1', '查询本周工时');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text', text: '回答' });

    runner.releaseSessionCallbacks(7, 'session-1');
    worker.emit('message', { type: 'event', sessionId: 'session-1', payload: { type: 'text', text: '过期事件' } });
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('同一会话不能同时绑定两个 SSE 窗口', async () => {
    await readyWorker();
    await runner.getOrCreateSession(7, undefined, { onEvent: vi.fn() });
    await expect(runner.getOrCreateSession(7, 'session-1', { onEvent: vi.fn() }))
      .rejects.toThrow('该会话已在其他窗口处理中');
  });

  it('长时间驻留的会话会在生成前刷新内部短期令牌', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const worker = await readyWorker();
    await runner.getOrCreateSession(7, undefined, {});
    now.mockReturnValue(1_000 + 91 * 60 * 1000);

    await runner.promptSession(7, 'session-1', '查询工时');

    expect(mocks.issueToken).toHaveBeenCalledTimes(2);
    expect(worker.posted.map(message => message.type)).toEqual(['create', 'refresh-token', 'prompt']);
    expect(worker.posted[1]).toMatchObject({
      userId: 7,
      sessionId: 'session-1',
      pat: 'agent-token-7',
    });
    now.mockRestore();
  });

  it('生成请求超时后主动通知 Worker 中止，避免孤儿任务长期占用并发槽位', async () => {
    const worker = await readyWorker();
    await runner.getOrCreateSession(7, undefined, {});
    worker.postMessage = vi.fn((message: any) => {
      worker.posted.push(message);
      if (message.type === 'abort') {
        queueMicrotask(() => worker.emit('message', { type: 'action-done', requestId: message.requestId }));
      }
    }) as any;
    vi.useFakeTimers();
    try {
      const pending = runner.promptSession(7, 'session-1', '耗时任务');
      const timedOut = expect(pending).rejects.toThrow('Agent 操作超时');
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      await timedOut;
      expect(worker.posted).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'prompt', sessionId: 'session-1' }),
        expect.objectContaining({ type: 'abort', sessionId: 'session-1', userId: 7 }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('Worker 退出会拒绝挂起请求，停止操作清空并终止线程', async () => {
    const worker = await readyWorker();
    // 不让 list 请求收到自动响应，模拟线程异常发生时仍有请求挂起。
    worker.postMessage = vi.fn((message: any) => { worker.posted.push(message); }) as any;
    const pending = runner.listSessions(7);
    await Promise.resolve();
    worker.emit('exit', 1);

    await expect(pending).rejects.toThrow('AI worker 已退出');
    await runner.stopAgentWorker();
    expect(worker.terminated).toBe(false);

    const second = await readyWorker();
    await runner.stopAgentWorker();
    expect(second.terminated).toBe(true);
  });
});
