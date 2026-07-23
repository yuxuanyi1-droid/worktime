import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '@client/components/AgentChat/useChat';
import { agentApi } from '@client/api/agent';
import { startChat } from '@client/components/AgentChat/sseClient';

vi.mock('@client/api/agent', () => ({
  agentApi: {
    getSessions: vi.fn(),
    createSession: vi.fn(),
    getHistory: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    abortSession: vi.fn(),
    queueMessage: vi.fn(),
  },
}));

vi.mock('@client/components/AgentChat/sseClient', () => ({
  startChat: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useChat', () => {
  beforeEach(() => {
    vi.mocked(agentApi.getSessions).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(agentApi.queueMessage).mockResolvedValue({ code: 0 });
    vi.mocked(agentApi.abortSession).mockResolvedValue({ code: 0 });
  });

  it('首次创建会话期间占用发送状态，阻止并发创建多个会话', async () => {
    const creating = deferred<{ code: number; data: { id: string; title: string } }>();
    vi.mocked(agentApi.createSession).mockReturnValue(creating.promise);
    const abort = vi.fn();
    vi.mocked(startChat).mockReturnValue({ abort } as unknown as AbortController);
    const { result } = renderHook(() => useChat());

    let firstSend!: Promise<boolean>;
    act(() => { firstSend = result.current.send('第一条消息'); });
    expect(result.current.sending).toBe(true);
    await expect(result.current.send('第二条消息')).rejects.toThrow('正在创建会话');
    expect(agentApi.createSession).toHaveBeenCalledTimes(1);

    creating.resolve({ code: 0, data: { id: 'session-1', title: '新对话' } });
    await expect(firstSend).resolves.toBe(true);
    expect(startChat).toHaveBeenCalledWith(
      { message: '第一条消息', sessionId: 'session-1', regenerate: undefined },
      expect.any(Object),
    );
  });

  it('生成期间把后续消息加入同一会话队列，完成后清空排队提示', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    let handlers: any;
    vi.mocked(startChat).mockImplementation((_body, nextHandlers) => {
      handlers = nextHandlers;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    const { result } = renderHook(() => useChat());

    await act(async () => { await result.current.send('第一条消息'); });
    await act(async () => { await result.current.send('排队消息'); });

    expect(agentApi.queueMessage).toHaveBeenCalledWith('session-1', '排队消息', 'followUp');
    expect(result.current.queuedMessages).toEqual(['排队消息']);

    act(() => handlers.onDone());
    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(result.current.queuedMessages).toEqual([]);
  });

  it('组件卸载时中止仍在读取的 SSE，避免后台请求泄漏', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    const abort = vi.fn();
    vi.mocked(startChat).mockReturnValue({ abort } as unknown as AbortController);
    const { result, unmount } = renderHook(() => useChat());

    await act(async () => { await result.current.send('查询工时'); });
    unmount();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('按 SSE 事件顺序合并思考、正文和工具状态，完成后刷新会话列表', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    vi.mocked(agentApi.getSessions).mockResolvedValue({
      code: 0,
      data: [{ id: 'session-1', title: '统计工时', preview: '', messageCount: 2, createdAt: '', updatedAt: '' }],
    });
    let handlers: any;
    vi.mocked(startChat).mockImplementation((_body, nextHandlers) => {
      handlers = nextHandlers;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('查询本月工时'); });

    act(() => {
      handlers.onEvent({
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '正在分析' }] },
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      });
      handlers.onEvent({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '分析完成' }] },
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 },
      });
      handlers.onEvent({
        type: 'tool_execution_start', toolName: 'worktime_query', toolCallId: 'tool-1',
        args: { resource: 'personal_report' },
      });
      handlers.onEvent({
        type: 'tool_execution_end', toolCallId: 'tool-1', isError: false,
        result: { content: [{ type: 'text', text: '{"days":5}' }] },
      });
      handlers.onEvent({
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'text', text: '本月共' }] },
        assistantMessageEvent: { type: 'text_start', contentIndex: 1 },
      });
      handlers.onEvent({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: '本月共 5 天' }] },
        assistantMessageEvent: { type: 'text_end', contentIndex: 1 },
      });
      handlers.onDone();
    });

    await waitFor(() => expect(result.current.sending).toBe(false));
    const assistant = result.current.messages.at(-1)!;
    expect(assistant.loading).toBe(false);
    expect(assistant.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', text: '分析完成', done: true }),
      expect.objectContaining({ type: 'tool', text: '查询工时数据', status: 'success', done: true }),
      expect.objectContaining({ type: 'text', text: '本月共 5 天', done: true }),
    ]));
    await waitFor(() => expect(agentApi.getSessions).toHaveBeenCalled());
  });

  it('SSE 错误会结束加载并把仍在执行的工具标为失败', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    let handlers: any;
    vi.mocked(startChat).mockImplementation((_body, nextHandlers) => {
      handlers = nextHandlers;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('查询工时'); });

    act(() => {
      handlers.onEvent({
        type: 'tool_execution_start', toolName: 'worktime_query', toolCallId: 'tool-1', args: {},
      });
      handlers.onError('模型服务不可用');
    });

    expect(result.current.sending).toBe(false);
    expect(result.current.messages.at(-1)).toMatchObject({
      loading: false,
      error: '模型服务不可用',
      parts: [expect.objectContaining({ type: 'tool', status: 'error', done: true })],
    });
  });

  it('服务端隐藏推理正文后仍能按 thinking_end 正确结束分析步骤', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    let handlers: any;
    vi.mocked(startChat).mockImplementation((_body, nextHandlers) => {
      handlers = nextHandlers;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('查询'); });

    act(() => {
      handlers.onEvent({
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      });
      handlers.onEvent({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 },
      });
    });

    expect(result.current.messages.at(-1)?.parts[0]).toMatchObject({
      type: 'thinking',
      text: '',
      done: true,
    });
  });

  it('流正常结束但没有正文时给出可操作提示，不把分析步骤伪装成回答', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    let handlers: any;
    vi.mocked(startChat).mockImplementation((_body, nextHandlers) => {
      handlers = nextHandlers;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('查询本周工时'); });

    act(() => {
      handlers.onEvent({
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      });
      handlers.onEvent({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 },
      });
      handlers.onDone();
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      loading: false,
      error: 'AI 未生成可展示的回答，请重新生成',
    });
  });

  it('停止生成会同时中止浏览器流和服务端会话', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    const abort = vi.fn();
    vi.mocked(startChat).mockReturnValue({ abort } as unknown as AbortController);
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('长任务'); });

    act(() => result.current.stop());

    expect(abort).toHaveBeenCalledOnce();
    expect(agentApi.abortSession).toHaveBeenCalledWith('session-1');
    expect(result.current.sending).toBe(false);
    expect(result.current.messages.at(-1)?.loading).toBe(false);
  });

  it('初始化加载最近会话，重命名和删除当前会话后切换到剩余会话', async () => {
    const session1 = { id: 'session-1', title: '会话一', preview: '', messageCount: 1, createdAt: '', updatedAt: '' };
    const session2 = { id: 'session-2', title: '会话二', preview: '', messageCount: 1, createdAt: '', updatedAt: '' };
    vi.mocked(agentApi.getSessions)
      .mockResolvedValueOnce({ code: 0, data: [session1, session2] })
      .mockResolvedValueOnce({ code: 0, data: [session2] });
    vi.mocked(agentApi.getHistory)
      .mockResolvedValueOnce({ code: 0, data: [{ id: 'm1', role: 'user', parts: [] }] as any })
      .mockResolvedValueOnce({ code: 0, data: [{ id: 'm2', role: 'assistant', parts: [] }] as any });
    vi.mocked(agentApi.renameSession).mockResolvedValue({ code: 0 });
    vi.mocked(agentApi.deleteSession).mockResolvedValue({ code: 0 });
    const { result } = renderHook(() => useChat());

    await act(async () => { await result.current.initialize(); });
    expect(result.current.currentSessionId).toBe('session-1');
    await act(async () => { await result.current.renameSession('session-1', '新标题'); });
    expect(result.current.sessions[0].title).toBe('新标题');

    await act(async () => { await result.current.deleteSession('session-1'); });
    expect(agentApi.deleteSession).toHaveBeenCalledWith('session-1');
    expect(result.current.currentSessionId).toBe('session-2');
    expect(result.current.messages[0].id).toBe('m2');
  });

  it('快速切换会话时只采纳最后一次选择，旧响应不能覆盖新会话', async () => {
    const first = deferred<{ code: number; data: any[] }>();
    const second = deferred<{ code: number; data: any[] }>();
    vi.mocked(agentApi.getHistory)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useChat());

    let firstSwitch!: Promise<void>;
    let secondSwitch!: Promise<void>;
    act(() => {
      firstSwitch = result.current.switchSession('session-1');
      secondSwitch = result.current.switchSession('session-2');
    });
    second.resolve({ code: 0, data: [{ id: 'new', role: 'assistant', parts: [] }] });
    await act(async () => { await secondSwitch; });
    first.resolve({ code: 0, data: [{ id: 'stale', role: 'assistant', parts: [] }] });
    await act(async () => { await firstSwitch; });

    expect(result.current.currentSessionId).toBe('session-2');
    expect(result.current.messages[0].id).toBe('new');
    expect(result.current.loadingSession).toBe(false);
  });

  it('重新生成会移除最后一组问答并用原问题发起 regenerate', async () => {
    vi.mocked(agentApi.createSession).mockResolvedValue({ code: 0, data: { id: 'session-1', title: '新对话' } });
    let handlers: any;
    vi.mocked(startChat).mockImplementation((_body, nextHandlers) => {
      handlers = nextHandlers;
      return { abort: vi.fn() } as unknown as AbortController;
    });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('原问题'); });
    act(() => handlers.onDone());
    await waitFor(() => expect(result.current.sending).toBe(false));
    vi.mocked(startChat).mockClear();

    act(() => result.current.regenerate());
    await waitFor(() => expect(startChat).toHaveBeenCalledWith(
      { message: '原问题', sessionId: 'session-1', regenerate: true },
      expect.any(Object),
    ));
    expect(startChat).toHaveBeenCalledTimes(1);
  });
});
