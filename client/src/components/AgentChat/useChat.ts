import { useState, useRef, useCallback } from 'react';
import { startChat } from './sseClient';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** 文本内容（助手消息边收边追加） */
  content: string;
  /** 正在进行的工具调用（skill 执行），展示"正在查询..." */
  toolStatus?: { toolName: string; running: boolean } | null;
  /** 消息是否仍在生成中 */
  loading?: boolean;
  /** 错误信息 */
  error?: string;
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
          switch (event.type) {
            case 'session':
              sessionIdRef.current = event.sessionId;
              break;
            case 'message_start':
              // 只显示 assistant 角色的消息。pi 还会发 role:toolResult（curl 的原始输出，
              // 如 {"code":0,"data":[]}）和 role:user 等消息，这些不应显示给用户。
              // 注意：仅在 content 非空时才重置，避免空消息覆盖已有内容导致气泡闪烁消失。
              if (event.message?.role === 'assistant') {
                const text = extractText(event.message);
                if (text) updateAssistant({ content: text, loading: true });
              }
              break;
            case 'message_update':
              // 流式更新：用最新 message 的全文替换（pi 推的是完整 message，非增量）。
              // 空文本时不覆盖（保留上一帧内容），避免渲染时气泡瞬间空白闪烁。
              if (event.message?.role === 'assistant') {
                const text = extractText(event.message);
                if (text) updateAssistant({ content: text, loading: true });
              }
              break;
            case 'message_end':
              if (event.message?.role === 'assistant') {
                const text = extractText(event.message);
                if (text) updateAssistant({ content: text });
                updateAssistant({ loading: false });
              }
              break;
            case 'tool_execution_start': {
              // 工具开始：显示"正在执行 ..."。toolName 通常是 bash（执行 skill 的 curl）
              const label = labelTool(event.toolName);
              updateAssistant({ toolStatus: { toolName: label, running: true } });
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
              // 其他事件（thinking、queue_update 等）暂不处理
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

  return { messages, sending, send, stop, clear };
}

/** 把 pi 的工具名转成中文标签（bash 通常是执行 skill 的 curl） */
function labelTool(toolName: string): string {
  if (!toolName) return '正在处理';
  if (toolName === 'bash') return '正在查询数据';
  return `正在执行 ${toolName}`;
}
