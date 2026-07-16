import { useState, useRef, useEffect } from 'react';
import {
  Input,
  Button,
  Space,
  Tooltip,
  Popover,
  Popconfirm,
  Spin,
  message as antdMessage,
} from 'antd';
import {
  CloseOutlined,
  ArrowUpOutlined,
  LoadingOutlined,
  CopyOutlined,
  ReloadOutlined,
  CheckOutlined,
  HistoryOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  DownOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
// 用 PrismLight 按需注册语言，避免打包全部语言（默认会引入数百种，体积巨大）
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';

SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('py', python);
import { useChat } from './useChat';

/**
 * 全局悬浮 AI 助手。
 * 右下角浮动按钮 + 右侧抽屉聊天面板。
 * 走当前用户 JWT session 鉴权（不走 PAT），PAT 仅用于 skill 内部 curl。
 */
export default function AgentChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [showLatest, setShowLatest] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<any>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const {
    messages,
    sessions,
    currentSessionId,
    sending,
    loadingSession,
    queuedMessages,
    initialize,
    switchSession,
    newSession,
    renameSession,
    deleteSession,
    send,
    stop,
    regenerate,
  } = useChat();

  const currentTitle = sessions.find((session) => session.id === currentSessionId)?.title || '新对话';

  useEffect(() => {
    if (!open) return;
    void initialize();
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 120);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [initialize, open]);

  useEffect(() => {
    if (!stickToBottomRef.current || !listRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    const id = 'agent-chat-keyframes';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `@keyframes agentPulse {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .agent-chat-trigger { animation: none !important; }
    }`;
    document.head.appendChild(style);
    return () => document.getElementById(id)?.remove();
  }, []);

  const scrollToLatest = () => {
    stickToBottomRef.current = true;
    setShowLatest(false);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  };

  const handleScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowLatest(!nearBottom);
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    stickToBottomRef.current = true;
    setShowLatest(false);
    void send(text).catch((error: any) => {
      setInput(text);
      antdMessage.error(error?.response?.data?.message || error?.message || '消息发送失败');
    });
  };

  const handleSuggestion = (suggestion: string) => {
    setInput('');
    stickToBottomRef.current = true;
    setShowLatest(false);
    void send(suggestion).catch((error: any) => {
      antdMessage.error(error?.response?.data?.message || error?.message || '消息发送失败');
    });
  };

  const suggestions = ['我这周填了多少工时', '我有几条待审批', '统计一下本月加班'];

  return (
    <>
      {!open && (
        <button
          className="agent-chat-trigger"
          type="button"
          onClick={() => setOpen(true)}
          aria-label="打开 AI 助手"
          style={{
            position: 'fixed',
            right: 32,
            bottom: 32,
            zIndex: 1000,
            width: 56,
            height: 56,
            padding: 0,
            border: 0,
            borderRadius: '50%',
            cursor: 'pointer',
            animation: 'agentPulse 2.4s ease-in-out infinite',
            background: 'linear-gradient(135deg, #7BA281 0%, #5C7E63 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 24px rgba(92, 126, 99, 0.5), inset 0 1px 2px rgba(255,255,255,0.25)',
          }}
        >
          <BrandLogo size={30} />
        </button>
      )}

      {open && (
          <aside
            aria-label="AI 工时助手"
            style={{
              position: 'fixed',
              top: 16,
              right: 16,
              bottom: 16,
              width: 440,
              maxWidth: 'calc(100% - 32px)',
              display: 'flex',
              flexDirection: 'column',
              background: '#FDFBF7',
              borderRadius: 16,
              boxShadow: '0 12px 40px rgba(44, 36, 24, 0.22)',
              overflow: 'hidden',
              zIndex: 1001,
            }}
          >
            <header
              style={{
                minHeight: 58,
                padding: '10px 14px',
                background: '#6B8F71',
                color: '#FDFBF7',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexShrink: 0,
              }}
            >
              <Space size={9} align="center">
                <BrandLogo size={24} withBackground />
                <Popover
                  trigger="click"
                  placement="bottomLeft"
                  open={historyOpen}
                  onOpenChange={setHistoryOpen}
                  content={
                    <SessionList
                      sessions={sessions}
                      currentSessionId={currentSessionId}
                      disabled={sending}
                      onSwitch={async (sessionId) => {
                        await switchSession(sessionId);
                        setHistoryOpen(false);
                      }}
                      onRename={renameSession}
                      onDelete={deleteSession}
                    />
                  }
                >
                  <button
                    type="button"
                    aria-label="查看最近对话"
                    style={{
                      maxWidth: 230,
                      padding: '4px 6px',
                      border: 0,
                      borderRadius: 7,
                      background: 'transparent',
                      color: '#FDFBF7',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ display: 'block', fontSize: 11, opacity: 0.78 }}>AI 助手</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 14, fontWeight: 600 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTitle}</span>
                      <DownOutlined style={{ fontSize: 9 }} />
                    </span>
                  </button>
                </Popover>
              </Space>
              <Space size={2}>
                <Tooltip title="新对话">
                  <Button
                    type="text"
                    aria-label="新建对话"
                    icon={<PlusOutlined style={{ color: '#FDFBF7' }} />}
                    disabled={sending || loadingSession}
                    onClick={() => {
                      setHistoryOpen(false);
                      void newSession().catch(() => antdMessage.error('新建对话失败'));
                    }}
                  />
                </Tooltip>
                <Tooltip title="关闭">
                  <Button
                    type="text"
                    aria-label="关闭 AI 助手"
                    icon={<CloseOutlined style={{ color: '#FDFBF7' }} />}
                    onClick={() => setOpen(false)}
                  />
                </Tooltip>
              </Space>
            </header>

            <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
              <div
                ref={listRef}
                onScroll={handleScroll}
                aria-live="polite"
                style={{
                  position: 'absolute',
                  inset: 0,
                  overflowY: 'auto',
                  padding: '18px 16px 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                {loadingSession && <Spin style={{ margin: '40px auto' }} />}
                {!loadingSession && messages.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#7A7060', fontSize: 13, marginTop: 36, padding: '0 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
                      <div
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: 16,
                          background: 'linear-gradient(135deg, #7BA281 0%, #5C7E63 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          boxShadow: '0 4px 12px rgba(92, 126, 99, 0.3)',
                        }}
                      >
                        <BrandLogo size={30} />
                      </div>
                    </div>
                    <div style={{ color: '#2C2418', fontSize: 15, fontWeight: 600 }}>今天想了解什么？</div>
                    <div style={{ marginTop: 6, color: '#9A9080' }}>我可以帮你查询工时、加班、周报和审批进度</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 18 }}>
                      {suggestions.map((suggestion) => (
                        <button
                          type="button"
                          key={suggestion}
                          disabled={loadingSession}
                          onClick={() => handleSuggestion(suggestion)}
                          style={{
                            padding: '9px 12px',
                            border: '1px solid #E8E0D4',
                            borderRadius: 10,
                            background: '#FFFFFF',
                            color: '#5F5648',
                            cursor: loadingSession ? 'not-allowed' : 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((message, index) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    isLast={index === messages.length - 1}
                    onRegenerate={regenerate}
                    sending={sending}
                  />
                ))}
              </div>
              {showLatest && (
                <Button
                  size="small"
                  icon={<ArrowDownOutlined />}
                  onClick={scrollToLatest}
                  style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: 10,
                    transform: 'translateX(-50%)',
                    borderColor: '#D8D0C2',
                    color: '#5F5648',
                    boxShadow: '0 3px 10px rgba(44,36,24,0.12)',
                  }}
                >
                  回到最新
                </Button>
              )}
            </div>

            <footer style={{ padding: '10px 12px 12px', flexShrink: 0, background: '#FDFBF7' }}>
              {queuedMessages.length > 0 && (
                <div style={{ margin: '0 6px 7px', fontSize: 12, color: '#7A7060' }}>
                  已排队 {queuedMessages.length} 条：{queuedMessages[queuedMessages.length - 1]}
                </div>
              )}
              <div
                style={{
                  background: '#FFFFFF',
                  border: '1px solid #D8D0C2',
                  borderRadius: 18,
                  boxShadow: '0 2px 8px rgba(44,36,24,0.06)',
                  padding: '8px 9px 8px 14px',
                }}
              >
                <Input.TextArea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onPressEnter={(event) => {
                    if (!event.shiftKey && !(event.nativeEvent as any).isComposing) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={sending ? '继续输入，发送后将排队处理' : '输入问题，Enter 发送'}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  variant="borderless"
                  style={{ padding: '3px 2px 7px', fontSize: 14, lineHeight: 1.55, resize: 'none' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 34 }}>
                  <span style={{ fontSize: 11, color: '#A39A8B' }}>Shift + Enter 换行</span>
                  <Space size={6}>
                    {sending && (
                      <Tooltip title="停止当前回答">
                        <button
                          type="button"
                          aria-label="停止当前回答"
                          onClick={stop}
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: '50%',
                            border: '1px solid #D8D0C2',
                            background: '#FFFFFF',
                            color: '#7A7060',
                            cursor: 'pointer',
                            display: 'grid',
                            placeItems: 'center',
                          }}
                        >
                          <span style={{ width: 9, height: 9, background: '#7A7060', borderRadius: 1 }} />
                        </button>
                      </Tooltip>
                    )}
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!input.trim() || loadingSession}
                      aria-label={sending ? '将消息加入队列' : '发送消息'}
                      title={sending ? '加入队列' : '发送'}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: '50%',
                        border: 'none',
                        background: input.trim() && !loadingSession ? '#6B8F71' : '#D8D0C2',
                        color: '#FDFBF7',
                        cursor: input.trim() && !loadingSession ? 'pointer' : 'not-allowed',
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      <ArrowUpOutlined style={{ fontSize: 14 }} />
                    </button>
                  </Space>
                </div>
              </div>
            </footer>
          </aside>
      )}
    </>
  );
}

function SessionList({
  sessions,
  currentSessionId,
  disabled,
  onSwitch,
  onRename,
  onDelete,
}: {
  sessions: import('../../api/agent').AgentSessionSummary[];
  currentSessionId?: string;
  disabled: boolean;
  onSwitch: (sessionId: string) => Promise<void>;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [title, setTitle] = useState('');

  const commitRename = async (sessionId: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    try {
      await onRename(sessionId, nextTitle);
      setEditingId(undefined);
    } catch {
      antdMessage.error('重命名失败');
    }
  };

  return (
    <div style={{ width: 310, maxWidth: 'calc(100vw - 64px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9, color: '#2C2418', fontWeight: 600 }}>
        <HistoryOutlined /> 最近对话
      </div>
      <div style={{ maxHeight: 330, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {sessions.length === 0 && <div style={{ padding: '22px 8px', color: '#9A9080', textAlign: 'center' }}>暂无历史对话</div>}
        {sessions.map((session) => (
          <div
            key={session.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 6px 5px 9px',
              borderRadius: 9,
              background: session.id === currentSessionId ? '#EEF3ED' : 'transparent',
            }}
          >
            {editingId === session.id ? (
              <Input
                size="small"
                value={title}
                maxLength={50}
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
                onPressEnter={(event) => event.currentTarget.blur()}
                onBlur={() => void commitRename(session.id)}
                style={{ flex: 1 }}
              />
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onSwitch(session.id).catch(() => antdMessage.error('加载对话失败'))}
                style={{
                  minWidth: 0,
                  flex: 1,
                  padding: '3px 0',
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  color: '#2C2418',
                }}
              >
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                  {session.title}
                </span>
                <span style={{ display: 'block', marginTop: 1, fontSize: 11, color: '#9A9080' }}>
                  {formatSessionTime(session.updatedAt)} · {session.messageCount} 条消息
                </span>
              </button>
            )}
            {editingId !== session.id && (
              <>
                <Tooltip title="重命名">
                  <Button
                    type="text"
                    size="small"
                    aria-label={`重命名 ${session.title}`}
                    disabled={disabled}
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditingId(session.id);
                      setTitle(session.title);
                    }}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除这条对话？"
                  description="删除后无法恢复"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => void onDelete(session.id).catch(() => antdMessage.error('删除对话失败'))}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label={`删除 ${session.title}`}
                    disabled={disabled}
                    icon={<DeleteOutlined />}
                  />
                </Popconfirm>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/**
 * 统一品牌徽标：圆角方块内含「对话气泡 + 闪光」AI 图标。
 * - 浮动按钮场景：透明底，图标用浅色（叠在绿色渐变圆上）。
 * - 顶栏场景（withBackground）：自带半透明白底，贴在绿色顶栏上更醒目。
 */
function BrandLogo({ size = 22, withBackground = false }: { size?: number; withBackground?: boolean }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: withBackground ? 'rgba(253, 251, 247, 0.22)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {/* 对话气泡 + 内部闪光（AI 感） */}
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#FDFBF7"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 气泡主体 */}
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        {/* 内部四角闪光（AI 智能感） */}
        <path d="M12 8l.7 2.3L15 11l-2.3.7L12 14l-.7-2.3L9 11l2.3-.7z" fill="#FDFBF7" stroke="none" />
      </svg>
    </div>
  );
}

/** 单条消息气泡 */
function MessageBubble({
  message,
  isLast,
  onRegenerate,
  sending,
}: {
  message: import('./useChat').ChatMessage;
  isLast: boolean;
  onRegenerate: () => void;
  sending: boolean;
}) {
  const isUser = message.role === 'user';
  const align = isUser ? 'flex-end' : 'flex-start';
  const bg = isUser ? '#6B8F71' : 'transparent';
  const color = isUser ? '#FDFBF7' : '#2C2418';
  const running = !!message.loading;

  // 用户消息：直接显示文本
  if (isUser) {
    const userText = message.parts.find((p) => p.type === 'text')?.text ?? '';
    return (
      <div style={{ display: 'flex', justifyContent: align }}>
        <div
          style={{
            maxWidth: '85%',
            padding: '9px 13px',
            borderRadius: '14px 14px 4px 14px',
            background: bg,
            color,
            fontSize: 13.5,
            lineHeight: 1.6,
            wordBreak: 'break-word',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {userText}
        </div>
      </div>
    );
  }

  // 助手消息：parts 时间线
  // 划分：最终答案（最后一个 text part）在外面显示；
  //       其余 text part（中间过渡文案）+ thinking/tool 统一收进折叠区。
  const allTextParts = message.parts.filter((p) => p.type === 'text');
  const lastTextPart = allTextParts[allTextParts.length - 1]; // 最终答案 / 当前正在生成的文案
  // 过程 part = thinking/tool + 非最后的 text（过渡文案）
  const processParts = message.parts.filter((p) => p.type !== 'text' || p.id !== lastTextPart?.id);
  // 正文 = 仅最后一个 text part（最终答案）
  const textParts = lastTextPart ? [lastTextPart] : [];
  const hasProcess = processParts.length > 0;
  // 完成且有 text part 才显示操作按钮
  const showActions = !running && textParts.length > 0 && !message.error;
  const canRegenerate = showActions && isLast && !sending;
  // 复制时只用最终答案
  const handleCopy = () => {
    const text = textParts.map((p) => p.text).join('\n\n');
    navigator.clipboard
      .writeText(text)
      .then(() => antdMessage.success('已复制'))
      .catch(() => antdMessage.error('复制失败'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align }}>
      <div
        style={{
          width: '100%',
          padding: '4px 2px',
          borderRadius: 0,
          background: bg,
          color,
          fontSize: 13.5,
          lineHeight: 1.6,
          wordBreak: 'break-word',
          boxShadow: 'none',
        }}
      >
        {/* 过程（思考/工具）统一折叠成一个"执行中 Xs"总条 */}
        {hasProcess && (
          <div style={{ marginBottom: textParts.length ? 8 : 0 }}>
            <ProcessGroup parts={processParts} running={running} startTime={message.startTime} />
          </div>
        )}
        {/* 正文（text parts）：markdown 渲染 */}
        {textParts.map((part, i) => (
          <PartView key={part.id} part={part} isLast={i === textParts.length - 1 && message.parts[message.parts.length - 1]?.type === 'text'} running={running} />
        ))}
        {/* 错误 */}
        {message.error && <div style={{ color: '#C0564B' }}>{message.error}</div>}
        {/* 等待首个 part */}
        {message.parts.length === 0 && !message.error && running && (
          <span style={{ color: '#9A9080' }}>思考中…</span>
        )}
      </div>
      {/* 助手消息的操作按钮（复制 / 重新生成） */}
      {showActions && (
        <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          <Tooltip title="复制">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={handleCopy} style={{ color: '#9A9080' }} />
          </Tooltip>
          {canRegenerate && (
            <Tooltip title="重新生成">
              <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRegenerate} style={{ color: '#9A9080' }} />
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 过程总折叠：所有思考/工具 part 统一收进一个"执行中 Xs / 已完成"条，
 * 展开后内部再按时间线展示各步骤（思考过程、工具调用，各自可折叠）。
 */
function ProcessGroup({
  parts,
  running,
  startTime,
}: {
  parts: import('./useChat').Part[];
  running: boolean;
  startTime?: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = startTime ? Math.max(0, Math.floor((now - startTime) / 1000)) : 0;
  // 统计步骤数
  const stepCount = parts.length;

  return (
    <CollapsibleBar
      icon={running ? <LoadingOutlined style={{ fontSize: 11 }} /> : undefined}
      label={running ? `执行中 ${elapsed}s` : `已完成 · 用时 ${elapsed}s · ${stepCount} 步`}
      defaultOpen={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {parts.map((part) => {
          const label = part.type === 'tool'
            ? `${part.text}${part.status === 'error' ? '失败' : part.done ? '完成' : '中'}`
            : part.type === 'thinking'
              ? part.done ? '问题分析完成' : '正在分析问题'
              : part.done ? '整理结果完成' : '正在整理结果';
          return (
            <CollapsibleBar
              key={part.id}
              icon={!part.done
                ? <LoadingOutlined style={{ fontSize: 11 }} />
                : <CheckOutlined style={{ fontSize: 11, color: part.status === 'error' ? '#C0564B' : '#6B8F71' }} />}
              label={label}
              defaultOpen={false}
            >
              <div
                style={{
                  maxHeight: 280,
                  overflow: 'auto',
                  padding: '2px 3px',
                  color: '#5F5648',
                  fontSize: 12,
                  lineHeight: 1.65,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: part.type === 'tool' ? 'Consolas, Monaco, monospace' : 'inherit',
                }}
              >
                {part.type === 'tool' ? part.detail || '正在等待查询结果…' : part.text || '正在生成分析内容…'}
              </div>
            </CollapsibleBar>
          );
        })}
      </div>
    </CollapsibleBar>
  );
}

/**
 * 正文 part 渲染：markdown，正在生成时尾部加光标。
 * 仅处理 text part（思考/工具由 ProcessGroup 统一折叠）。
 */
function PartView({
  part,
  isLast,
  running,
}: {
  part: import('./useChat').Part;
  isLast: boolean;
  running: boolean;
}) {
  const streaming = running && isLast && !part.done;
  return (
    <div className="agent-md" style={{ marginBottom: 6 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {part.text}
      </ReactMarkdown>
      {streaming && <span style={{ color: '#9A9080' }}> ▍</span>}
    </div>
  );
}

/**
 * 通用折叠条：一行可点击的标题 + 展开后的内容。默认收起。
 */
function CollapsibleBar({
  label,
  icon,
  children,
  defaultOpen = false,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      style={{
        marginBottom: 6,
        padding: '5px 10px',
        background: 'rgba(44, 36, 24, 0.05)',
        borderRadius: 8,
        border: '1px solid rgba(44, 36, 24, 0.08)',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          padding: 0,
          border: 0,
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          color: '#7A7060',
          fontSize: 12,
          userSelect: 'none',
        }}
      >
        {icon}
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 11, color: '#9A9080', marginLeft: 'auto' }}>{open ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

/**
 * 带复制按钮的代码块。
 */
function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard
      .writeText(children)
      .then(() => {
        setCopied(true);
        antdMessage.success('代码已复制');
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => antdMessage.error('复制失败'));
  };
  return (
    <div style={{ position: 'relative', margin: '8px 0', borderRadius: 8, overflow: 'hidden' }}>
      {/* 顶栏：语言名 + 复制按钮 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 10px',
          background: '#EEE7DA',
          fontSize: 11,
          color: '#7A7060',
        }}
      >
        <span>{language || 'text'}</span>
        <Button
          type="text"
          size="small"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={handleCopy}
          style={{ color: '#7A7060', fontSize: 11 }}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneLight}
        customStyle={{ margin: 0, fontSize: 12.5, borderRadius: 0, padding: '10px 12px' }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

/**
 * react-markdown 的组件覆盖：代码高亮 + 暖色调 Markdown 样式。
 * 区分行内代码（inline）与代码块。
 */
const markdownComponents: Components = {
  // code：react-markdown v10 中，行内 code 的 props 有 inline 标志
  code(props) {
    const { children, className, node, ...rest } = props;
    const match = /language-(\w+)/.exec(className || '');
    const text = String(children).replace(/\n$/, '');
    // 有 language-xxx 类名 → 代码块；否则行内 code
    if (match) {
      return <CodeBlock language={match[1]}>{text}</CodeBlock>;
    }
    // 行内代码：判断是否多行（含换行则当代码块处理）
    if (text.includes('\n')) {
      return <CodeBlock language="">{text}</CodeBlock>;
    }
    return (
      <code
        {...rest}
        style={{
          background: 'rgba(44, 36, 24, 0.08)',
          padding: '1px 5px',
          borderRadius: 4,
          fontSize: 12.5,
          fontFamily: 'Consolas, Monaco, monospace',
        }}
      >
        {children}
      </code>
    );
  },
  // 表格
  table({ children }) {
    return (
      <div style={{ maxWidth: '100%', overflowX: 'auto', margin: '8px 0' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 360, fontSize: 12.5 }}>{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th style={{ border: '1px solid #E8E0D4', padding: '5px 8px', background: '#F8F4ED', textAlign: 'left' }}>
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td style={{ border: '1px solid #E8E0D4', padding: '5px 8px' }}>{children}</td>;
  },
  // 引用块
  blockquote({ children }) {
    return (
      <blockquote
        style={{ borderLeft: '3px solid #6B8F71', margin: '8px 0', padding: '2px 10px', color: '#7A7060' }}
      >
        {children}
      </blockquote>
    );
  },
  // 列表
  ul({ children }) {
    return <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{children}</ul>;
  },
  ol({ children }) {
    return <ol style={{ margin: '6px 0', paddingLeft: 20 }}>{children}</ol>;
  },
  p({ children }) {
    return <p style={{ margin: '6px 0' }}>{children}</p>;
  },
};
