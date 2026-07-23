import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { startChat } from '@client/components/AgentChat/sseClient';
import { useAuthStore } from '@client/stores/authStore';

function streamResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

beforeEach(() => {
  useAuthStore.getState().clearAuth();
  vi.restoreAllMocks();
});

describe('startChat', () => {
  it('解析跨分块和 CRLF 分隔的 SSE，并在 done 时只完成一次', async () => {
    localStorage.setItem('token', 'jwt-token');
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"text","delta":"你"}\r\n',
      '\r\ndata: {"type":"done"}\r\n\r\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    startChat({ message: '查询工时' }, { onEvent, onDone, onError });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith({ type: 'text', delta: '你' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'done' });
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-token');
  });

  it('401 时清除认证状态并派发全局未授权事件', async () => {
    useAuthStore.getState().setAuth('expired-token', {
      id: 1,
      username: 'u',
      realName: '用户',
      department: null,
      group: null,
      roles: [],
      permissions: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const unauthorized = vi.fn();
    window.addEventListener('unauthorized', unauthorized);
    const onError = vi.fn();

    startChat({ message: 'test' }, { onEvent: vi.fn(), onDone: vi.fn(), onError });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('登录已失效'));
    expect(useAuthStore.getState().token).toBeNull();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    window.removeEventListener('unauthorized', unauthorized);
  });

  it('非成功响应优先展示服务端错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'AI 服务繁忙，请稍后重试' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )));
    const onError = vi.fn();

    startChat({ message: 'test' }, { onEvent: vi.fn(), onDone: vi.fn(), onError });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('AI 服务繁忙，请稍后重试'));
  });

  it('没有 done 或错误终帧就关闭时提示连接中断，不能把半截回答标成成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"message_update"}\n\n',
    ])));
    const onDone = vi.fn();
    const onError = vi.fn();

    startChat({ message: 'test' }, { onEvent: vi.fn(), onDone, onError });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('AI 连接意外中断，请重试'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('服务端错误帧作为终态结束，不再追加误导性的连接中断错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {"type":"error","message":"AI 处理失败，请稍后重试"}\n\n',
    ])));
    const onEvent = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    startChat({ message: 'test' }, { onEvent, onDone, onError });

    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onEvent).toHaveBeenCalledWith({ type: 'error', message: 'AI 处理失败，请稍后重试' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('SSE JSON 损坏时明确失败，不能跳过后把不完整回答标成成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      'data: {not-json}\n\ndata: {"type":"done"}\n\n',
    ])));
    const onDone = vi.fn();
    const onError = vi.fn();

    startChat({ message: 'test' }, { onEvent: vi.fn(), onDone, onError });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('AI 响应格式异常，请重试'));
    expect(onDone).not.toHaveBeenCalled();
  });
});
