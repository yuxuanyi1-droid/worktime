import { useState, useRef, useCallback } from 'react';
import { startChat } from './sseClient';

export type ChatRole = 'user' | 'assistant';

/**
 * 中间过程的单个事件（按真实时序排列，保留"思考→工具→思考→工具"的交织顺序）。
 * 一个气泡的 trace 是一个有序列表，渲染时按顺序展示，不合并同类。
 */
export interface TraceItem {
  /** 思考片段 / 工具调用 */
  type: 'thinking' | 'tool';
  /** 内容：thinking=推理文本，tool=工具名标签 */
  text: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** 文本内容：用户消息=原文；助手消息=最终答案（最后一轮非空 text） */
  content: string;
  /** 中间过程（按真实时序：思考片段与工具调用交织），整体折叠展示 */
  trace?: TraceItem[];
  /** 正在进行的工具调用（skill 执行），展示"正在查询..." */
  toolStatus?: { toolName: string; running: boolean } | null;
  /** 消息是否仍在生成中 */
  loading?: boolean;
  /** 错误信息 */
  error?: string;
  /** 本次回答开始时间戳（用于计算执行耗时） */
  startTime?: number;
}

let idSeq = 0;
const genId = () => `m${Date.now()}_${idSeq++}`;

/**
 * 从 pi 的 message 对象中提取纯文本。
 * message.content 通常是 [{type:'text', text:'...'}, ...]，也可能直接是字符串。
 */
function extractText(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c && typeof c === 'object' && c.type === 'text' ? c.text || '' : ''))
      .join('');
  }
  return '';
}

/**
 * 从 pi 的 message 对象中提取思考过程（reasoning 模型的 thinking 块）。
 * thinking 块形如 { type:'thinking', thinking:'...', thinkingSignature:'...' }。
 */
function extractThinking(message: any): string {
  if (!message) return '';
  const content = message.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c && typeof c === 'object' && c.type === 'thinking' ? c.thinking || '' : ''))
    .join('');
}

/**
 * 聊天状态管理 hook。
 * 维护消息列表 + sessionId，调用后端 /agent/chat（SSE）。
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const userMsg: ChatMessage = { id: genId(), role: 'user', content: trimmed };
    const assistantMsg: ChatMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      loading: true,
      toolStatus: null,
      startTime: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setSending(true);

    const updateAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m)),
      );
    };

    abortRef.current = startChat(
      { message: trimmed, sessionId: sessionIdRef.current },
      {
        onEvent: (event) => {
          const subType = event.assistantMessageEvent?.type;
          switch (event.type) {
            case 'session':
              sessionIdRef.current = event.sessionId;
              break;
            case 'message_start':
            case 'message_update': {
              // 只处理 assistant 消息（pi 还会发 role:toolResult/user 等，不显示）。
              if (event.message?.role === 'assistant') {
                const text = extractText(event.message);
                const thinking = extractThinking(event.message);
                if (thinking) {
                  // 思考段：thinking_start 新开一段；否则延续最后一段（若被打断则新开）。
                  // 这样保留"思考→工具→思考→工具"的真实交织顺序。
                  setMessages((prev) =>
                    prev.map((m) => {
                      if (m.id !== assistantMsg.id) return m;
                      const trace = [...(m.trace ?? [])];
                      const last = trace[trace.length - 1];
                      const shouldAppend =
                        subType === 'thinking_start' || !last || last.type !== 'thinking';
                      if (shouldAppend) {
                        trace.push({ type: 'thinking', text: thinking });
                      } else {
                        // 延续：更新最后一段思考的全文
                        trace[trace.length - 1] = { type: 'thinking', text: thinking };
                      }
                      return { ...m, trace, loading: true };
                    }),
                  );
                }
                // text 作为正文（最终答案）流式展示
                if (text) {
                  updateAssistant({ content: text, loading: true });
                }
              }
              break;
            }
            case 'message_end':
              // assistant 消息结束：定稿正文与思考。补 thinking 防御 pi 时序变化导致丢失。
              if (event.message?.role === 'assistant') {
                const patch: Partial<ChatMessage> = { loading: false };
                const text = extractText(event.message);
                if (text) patch.content = text;
                const thinking = extractThinking(event.message);
                if (thinking) {
                  setMessages((prev) =>
                    prev.map((m) => {
                      if (m.id !== assistantMsg.id) return m;
                      const trace = [...(m.trace ?? [])];
                      const last = trace[trace.length - 1];
                      // 仅当最后一段是 thinking 才更新（避免重复新增）
                      if (last && last.type === 'thinking') {
                        trace[trace.length - 1] = { type: 'thinking', text: thinking };
                      }
                      return { ...m, trace, ...patch };
                    }),
                  );
                } else {
                  updateAssistant(patch);
                }
              }
              break;
            case 'tool_execution_start': {
              // 工具调用：追加一个 tool 项。它会"打断"当前思考段——
              // 之后的 thinking 因 last.type !== 'thinking' 会自动新开一段。
              const label = labelTool(event.toolName);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        trace: [...(m.trace ?? []), { type: 'tool', text: label }],
                        toolStatus: { toolName: label, running: true },
                        loading: true,
                      }
                    : m,
                ),
              );
              break;
            }
            case 'tool_execution_end':
              updateAssistant({ toolStatus: null });
              break;
            case 'turn_end':
              updateAssistant({ loading: false, toolStatus: null });
              break;
            case 'error':
              updateAssistant({ loading: false, error: event.message || 'AI 处理失败' });
              break;
            default:
              // 其他事件（queue_update 等）暂不处理
              break;
          }
        },
        onError: (msg) => {
          updateAssistant({ loading: false, error: msg });
          setSending(false);
        },
        onDone: () => {
          updateAssistant({ loading: false, toolStatus: null });
          setSending(false);
        },
      },
    );
  }, [sending]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setMessages((prev) =>
      prev.map((m) => (m.loading ? { ...m, loading: false, content: m.content || '（已中断）' } : m)),
    );
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    sessionIdRef.current = undefined;
    setMessages([]);
    setSending(false);
  }, []);

  /**
   * 重新生成最后一条助手回答：移除最后的一组（用户+助手），重新发送该用户消息。
   * 复用 sessionId（保持上下文），但丢弃上次回答。
   */
  const regenerate = useCallback(() => {
    if (sending) return;
    setMessages((prev) => {
      if (prev.length < 2) return prev;
      const last = prev[prev.length - 1];
      const userMsg = prev[prev.length - 2];
      if (last.role !== 'assistant' || userMsg.role !== 'user') return prev;
      // 移除最后这组（用户+助手），稍后由 send 重新加入
      queueMicrotask(() => send(userMsg.content));
      return prev.slice(0, -2);
    });
  }, [sending, send]);

  return { messages, sending, send, stop, clear, regenerate };
}

/** 把 pi 的工具名转成中文标签（bash 通常是执行 skill 的 curl） */
function labelTool(toolName: string): string {
  if (!toolName) return '正在处理';
  if (toolName === 'bash') return '正在查询数据';
  return `正在执行 ${toolName}`;
}
