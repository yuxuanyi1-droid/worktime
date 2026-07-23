import { useAuthStore } from '../../stores/authStore';

/**
 * Agent 聊天的 SSE 客户端。
 *
 * 用裸 fetch + ReadableStream 读取 /agent/chat 的 text/event-stream，
 * 绕过 utils/request.ts 的 axios 实例（其响应拦截器会把流当 JSON 解析、且 timeout 30s 会断流）。
 *
 * 解析 SSE 帧：`data: <json>\n\n`，每帧的 json 即一个 pi 事件对象（含 type 字段）。
 */

export interface SseHandlers {
  /** 收到一个事件（已 JSON.parse） */
  onEvent: (event: any) => void;
  /** 网络错误或非 2xx 响应 */
  onError: (message: string) => void;
  /** 流正常结束（收到 done 或服务端关闭） */
  onDone: () => void;
}

/** 拼接 /agent/chat 的完整 URL，处理子路径部署（__BASE_PATH__ 由 vite 注入） */
function buildUrl(): string {
  const base = (typeof __BASE_PATH__ !== 'undefined' ? __BASE_PATH__ : '') || '';
  return `${base}/api/v1/agent/chat`;
}

/**
 * 发起一次聊天 SSE 请求。
 * @returns AbortController（调用 .abort() 可中断流，如用户关闭抽屉）
 */
export function startChat(
  body: { message: string; sessionId?: string; regenerate?: boolean },
  handlers: SseHandlers,
): AbortController {
  const controller = new AbortController();
  const token = localStorage.getItem('token');

  (async () => {
    let res: Response;
    try {
      res = await fetch(buildUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      handlers.onError(e?.message || '网络连接失败');
      return;
    }

    // 401：登录失效，触发全局退出
    if (res.status === 401) {
      useAuthStore.getState().clearAuth();
      handlers.onError('登录已失效');
      window.dispatchEvent(new CustomEvent('unauthorized'));
      return;
    }
    // 503：AI 未配置；429：限流；其他非 2xx
    if (!res.ok) {
      let msg = `请求失败（${res.status}）`;
      try {
        const data = await res.json();
        msg = data.message || msg;
      } catch {
        /* ignore */
      }
      handlers.onError(msg);
      return;
    }
    if (!res.body) {
      handlers.onError('响应流不可用');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedDone = false;
    let receivedTerminalError = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 标准允许 CRLF；统一为 LF 后再按空行切帧。
        buffer = buffer.replace(/\r\n/g, '\n');
        // 按双换行切帧（SSE 帧以 \n\n 分隔）
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          // 解析 data: 行（可能多行，合并）
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^\s/, ''));
          if (dataLines.length === 0) continue;
          const jsonStr = dataLines.join('\n');
          try {
            const event = JSON.parse(jsonStr);
            handlers.onEvent(event);
            if (event.type === 'done') {
              receivedDone = true;
              handlers.onDone();
              return;
            }
            if (event.type === 'error') receivedTerminalError = true;
          } catch {
            throw new Error('AI 响应格式异常，请重试');
          }
        }
      }
      if (controller.signal.aborted || receivedDone) return;
      // 服务端成功路径一定发送 done。错误帧是另一种终态；两者都没有时说明代理或网络提前截断。
      if (receivedTerminalError) handlers.onDone();
      else handlers.onError('AI 连接意外中断，请重试');
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      handlers.onError(e?.message || '读取响应流失败');
    }
  })();

  return controller;
}
