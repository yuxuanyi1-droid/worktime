import { useCallback, useEffect, useRef, useState } from 'react';
import { agentApi, type AgentSessionSummary } from '../../api/agent';
import { startChat } from './sseClient';

export type ChatRole = 'user' | 'assistant';
export type PartType = 'text' | 'thinking' | 'tool';

export interface Part {
  id: string;
  type: PartType;
  text: string;
  contentIndex?: number;
  toolCallId?: string;
  /** 工具参数或返回结果，仅用于折叠详情展示 */
  detail?: string;
  status?: 'running' | 'success' | 'error';
  done?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  parts: Part[];
  loading?: boolean;
  error?: string;
  startTime?: number;
}

let idSeq = 0;
const genId = () => `p${Date.now()}_${idSeq++}`;

function extractContent(message: any, type: 'text' | 'thinking'): string {
  if (!message) return '';
  if (type === 'text' && typeof message === 'string') return message;
  const content = message.content;
  if (type === 'text' && typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      if (!part || typeof part !== 'object' || part.type !== type) return '';
      return type === 'text' ? part.text || '' : part.thinking || '';
    })
    .join('');
}

function labelTool(toolName: string): string {
  if (!toolName || toolName === 'worktime_query') return '查询工时数据';
  return toolName;
}

function formatDetail(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2).slice(0, 20000);
    } catch {
      return value.slice(0, 20000);
    }
  }
  if (typeof value === 'object') {
    const result = value as any;
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter((item: any) => item?.type === 'text')
        .map((item: any) => item.text || '')
        .join('\n');
      if (text) return formatDetail(text);
    }
    try {
      return JSON.stringify(value, null, 2).slice(0, 20000);
    } catch {
      return String(value).slice(0, 20000);
    }
  }
  return String(value);
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const sessionIdRef = useRef<string>();
  const sendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const initializedRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sessionLoadRequestIdRef = useRef(0);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => {
    sessionLoadRequestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const setSessionId = useCallback((sessionId?: string) => {
    sessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
  }, []);

  const updateParts = useCallback(
    (messageId: string, updater: (parts: Part[]) => Part[], extra?: Partial<ChatMessage>) => {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === messageId
            ? { ...message, parts: updater(message.parts), ...extra }
            : message,
        ),
      );
    },
    [],
  );

  const refreshSessions = useCallback(async () => {
    const response = await agentApi.getSessions();
    setSessions(response.data);
    return response.data;
  }, []);

  const switchSession = useCallback(async (sessionId: string) => {
    if (sendingRef.current || sessionId === sessionIdRef.current) return;
    const requestId = ++sessionLoadRequestIdRef.current;
    setLoadingSession(true);
    try {
      const response = await agentApi.getHistory(sessionId);
      if (requestId !== sessionLoadRequestIdRef.current) return;
      setMessages(response.data);
      setQueuedMessages([]);
      setSessionId(sessionId);
    } finally {
      if (requestId === sessionLoadRequestIdRef.current) setLoadingSession(false);
    }
  }, [setSessionId]);

  const initialize = useCallback(async () => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    try {
      const available = await refreshSessions();
      if (available[0] && !sessionIdRef.current) await switchSession(available[0].id);
    } catch {
      initializedRef.current = false;
    }
  }, [refreshSessions, switchSession]);

  const newSession = useCallback(async () => {
    if (sendingRef.current) return;
    sessionLoadRequestIdRef.current += 1;
    setLoadingSession(false);
    setSessionId(undefined);
    setMessages([]);
    setQueuedMessages([]);
  }, [setSessionId]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    await agentApi.renameSession(sessionId, title);
    setSessions((previous) =>
      previous.map((session) => (session.id === sessionId ? { ...session, title } : session)),
    );
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (sendingRef.current && sessionId === sessionIdRef.current) return;
    await agentApi.deleteSession(sessionId);
    const remaining = await refreshSessions();
    if (sessionId === sessionIdRef.current) {
      setSessionId(undefined);
      setMessages([]);
      setQueuedMessages([]);
      if (remaining[0]) await switchSession(remaining[0].id);
    }
  }, [refreshSessions, setSessionId, switchSession]);

  const queueMessage = useCallback(async (text: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return false;
    await agentApi.queueMessage(sessionId, text, 'followUp');
    setQueuedMessages((previous) => [...previous, text]);
    return true;
  }, []);

  const send = useCallback(async (text: string, options?: { regenerate?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (sendingRef.current) {
      if (options?.regenerate) return false;
      const queued = await queueMessage(trimmed);
      if (!queued) throw new Error('正在创建会话，请稍后再发送');
      return true;
    }

    // 必须在首次 createSession 的 await 之前占用发送状态，否则快速连续点击会并发
    // 创建多个服务端会话，并让后返回的 sessionId 覆盖先返回的会话。
    sendingRef.current = true;
    setSending(true);
    let sessionId = sessionIdRef.current;
    try {
      if (!sessionId) {
        const response = await agentApi.createSession();
        sessionId = response.data.id;
        setSessionId(sessionId);
      }
    } catch (error) {
      sendingRef.current = false;
      setSending(false);
      throw error;
    }

    const userMessage: ChatMessage = {
      id: genId(),
      role: 'user',
      parts: [{ id: genId(), type: 'text', text: trimmed, done: true }],
    };
    const assistantMessage: ChatMessage = {
      id: genId(),
      role: 'assistant',
      parts: [],
      loading: true,
      startTime: Date.now(),
    };
    setMessages((previous) => [...previous, userMessage, assistantMessage]);
    const assistantId = assistantMessage.id;

    abortRef.current = startChat(
      { message: trimmed, sessionId, regenerate: options?.regenerate },
      {
        onEvent: (event) => {
          const subtype = event.assistantMessageEvent?.type;
          const isAssistant = event.message?.role === 'assistant';
          switch (event.type) {
            case 'session':
              setSessionId(event.sessionId);
              break;
            case 'message_start':
            case 'message_update': {
              if (!isAssistant) break;
              const contentIndex = event.assistantMessageEvent?.contentIndex;
              const isThinking = subtype?.startsWith('thinking_');
              const isText = subtype?.startsWith('text_');
              if (!isThinking && !isText) break;
              const type: 'thinking' | 'text' = isThinking ? 'thinking' : 'text';
              const content = extractContent(event.message, type);
              if (subtype.endsWith('_start')) {
                updateParts(assistantId, (parts) => [
                  ...parts,
                  { id: genId(), type, text: content, contentIndex },
                ]);
              } else {
                updateParts(assistantId, (parts) => {
                  let index = -1;
                  for (let i = parts.length - 1; i >= 0; i -= 1) {
                    const part = parts[i];
                    if (part.type === type && part.contentIndex === contentIndex && !part.done) {
                      index = i;
                      break;
                    }
                  }
                  if (index < 0) return parts;
                  const updated = {
                    ...parts[index],
                    text: content || parts[index].text,
                    done: subtype.endsWith('_end') || undefined,
                  };
                  return [...parts.slice(0, index), updated, ...parts.slice(index + 1)];
                });
              }
              break;
            }
            case 'tool_execution_start':
              updateParts(assistantId, (parts) => [
                ...parts,
                {
                  id: genId(),
                  type: 'tool',
                  text: labelTool(event.toolName),
                  toolCallId: event.toolCallId,
                  detail: formatDetail(event.args),
                  status: 'running',
                },
              ]);
              break;
            case 'tool_execution_end':
              updateParts(assistantId, (parts) =>
                parts.map((part) =>
                  part.type === 'tool' && part.toolCallId === event.toolCallId
                    ? {
                        ...part,
                        status: event.isError ? 'error' : 'success',
                        detail: formatDetail(event.result) || part.detail,
                        done: true,
                      }
                    : part,
                ),
              );
              break;
            case 'error':
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === assistantId
                    ? {
                        ...message,
                        loading: false,
                        error: event.message || 'AI 处理失败',
                        parts: message.parts.map((part) => ({
                          ...part,
                          done: true,
                          status: part.type === 'tool' && part.status === 'running' ? 'error' : part.status,
                        })),
                      }
                    : message,
                ),
              );
              break;
            default:
              break;
          }
        },
        onError: (errorMessage) => {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    loading: false,
                    error: errorMessage,
                    parts: message.parts.map((part) => ({
                      ...part,
                      done: true,
                      status: part.type === 'tool' && part.status === 'running' ? 'error' : part.status,
                    })),
                  }
                : message,
            ),
          );
          abortRef.current = null;
          sendingRef.current = false;
          setSending(false);
          setQueuedMessages([]);
        },
        onDone: () => {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    loading: false,
                    parts: message.parts.map((part) => ({
                      ...part,
                      done: true,
                      status: part.type === 'tool' && part.status === 'running' ? 'success' : part.status,
                    })),
                  }
                : message,
            ),
          );
          abortRef.current = null;
          sendingRef.current = false;
          setSending(false);
          setQueuedMessages([]);
          void refreshSessions();
        },
      },
    );
    return true;
  }, [queueMessage, refreshSessions, setSessionId, updateParts]);

  const stop = useCallback(() => {
    const sessionId = sessionIdRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    if (sessionId) void agentApi.abortSession(sessionId).catch(() => undefined);
    sendingRef.current = false;
    setSending(false);
    setQueuedMessages([]);
    setMessages((previous) =>
      previous.map((message) =>
        message.loading
          ? {
              ...message,
              loading: false,
              parts: message.parts.map((part) => ({ ...part, done: true })),
            }
          : message,
      ),
    );
  }, []);

  const regenerate = useCallback(() => {
    if (sendingRef.current) return;
    const snapshot = messagesRef.current;
    if (snapshot.length < 2) return;
    const assistantMessage = snapshot[snapshot.length - 1];
    const userMessage = snapshot[snapshot.length - 2];
    if (assistantMessage.role !== 'assistant' || userMessage.role !== 'user') return;
    const userText = userMessage.parts.find((part) => part.type === 'text')?.text;
    if (!userText) return;
    setMessages((previous) => previous[previous.length - 1]?.id === assistantMessage.id ? previous.slice(0, -2) : previous);
    void send(userText, { regenerate: true });
  }, [send]);

  return {
    messages,
    sessions,
    currentSessionId,
    sending,
    loadingSession,
    queuedMessages,
    initialize,
    refreshSessions,
    switchSession,
    newSession,
    renameSession,
    deleteSession,
    send,
    stop,
    regenerate,
  };
}
