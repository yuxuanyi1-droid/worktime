import { useState, useRef, useEffect } from 'react';
import { Input, Button, Space, Tooltip, message as antdMessage } from 'antd';
import {
  CloseOutlined,
  ArrowUpOutlined,
  ClearOutlined,
  LoadingOutlined,
  CopyOutlined,
  ReloadOutlined,
  CheckOutlined,
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
  const { messages, sending, send, stop, clear, regenerate } = useChat();
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息时自动滚到底
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // 注入浮动按钮脉冲动画（仅一次）。项目无全局 CSS，用 <style> 注入 keyframes。
  useEffect(() => {
    const id = 'agent-chat-keyframes';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `@keyframes agentPulse {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }`;
    document.head.appendChild(style);
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    send(text);
    setInput('');
  };

  return (
    <>
      {/* 浮动按钮：渐变圆形 + 统一品牌徽标 + 轻微脉冲提示 */}
      {!open && (
        <div
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed',
            right: 32,
            bottom: 32,
            zIndex: 1000,
            cursor: 'pointer',
            animation: 'agentPulse 2.4s ease-in-out infinite',
          }}
          title="AI 助手"
        >
          {/* 外圈光晕 */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #7BA281 0%, #5C7E63 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(92, 126, 99, 0.5), inset 0 1px 2px rgba(255,255,255,0.25)',
              transition: 'transform 0.2s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            <BrandLogo size={30} />
          </div>
        </div>
      )}

      {/* 聊天浮窗：自定义悬浮卡片（不用 Drawer，避免其多层 DOM 的默认背景导致圆角弧线）。
          约占视口 2/3 高，上/下/右留白，16px 圆角，整体一个元素控制圆角无歧义。 */}
      {open && (
        <>
          {/* 半透明遮罩：点击关闭 */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(44,36,24,0.18)', zIndex: 1000 }}
          />
          {/* 浮窗主体 */}
          <div
            style={{
              position: 'fixed',
              top: 24,
              right: 24,
              bottom: 24,
              width: 420,
              maxWidth: 'calc(100vw - 48px)',
              display: 'flex',
              flexDirection: 'column',
              background: '#FDFBF7',
              borderRadius: 16,
              boxShadow: '0 12px 40px rgba(44, 36, 24, 0.22)',
              overflow: 'hidden',
              zIndex: 1001,
            }}
          >
        {/* 顶栏 */}
        <div
          style={{
            padding: '14px 18px',
            background: '#6B8F71',
            color: '#FDFBF7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <Space size={8} align="center">
            <BrandLogo size={22} withBackground />
            <span style={{ fontWeight: 600, fontSize: 15 }}>AI 助手</span>
          </Space>
          <Space size={4}>
            <Tooltip title="清空对话">
              <Button
                type="text"
                size="small"
                icon={<ClearOutlined style={{ color: '#FDFBF7' }} />}
                onClick={clear}
              />
            </Tooltip>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined style={{ color: '#FDFBF7' }} />}
              onClick={() => setOpen(false)}
            />
          </Space>
        </div>

        {/* 消息列表 */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9A9080', fontSize: 13, marginTop: 40, padding: '0 12px' }}>
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
              你好，我是工时助手。可以问我：
              <div style={{ marginTop: 8, lineHeight: 1.8 }}>
                「我这周填了多少工时」<br />
                「我有几条待审批」<br />
                「我的加班统计」
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              isLast={i === messages.length - 1}
              onRegenerate={regenerate}
              sending={sending}
            />
          ))}
        </div>

        {/* 输入区：输入框与发送按钮水平排列，按钮垂直居中（单行）/贴底（多行） */}
        <div style={{ borderTop: '1px solid #E8E0D4', padding: 12, flexShrink: 0, background: '#FDFBF7' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 4 }}
              style={{ borderRadius: 10, borderColor: '#E8E0D4', flex: 1 }}
              disabled={sending}
            />
            {/* 圆形发送/停止按钮：flex 兄弟，垂直居中 */}
            {sending ? (
              <button
                onClick={stop}
                title="停止"
                style={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  borderRadius: '50%',
                  border: 'none',
                  background: '#9A9080',
                  color: '#FDFBF7',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                {/* 实心方块（停止符号） */}
                <span style={{ width: 10, height: 10, background: '#FDFBF7', borderRadius: 1, display: 'block' }} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                title="发送"
                style={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  borderRadius: '50%',
                  border: 'none',
                  background: input.trim() ? '#6B8F71' : '#D8D0C2',
                  color: '#FDFBF7',
                  cursor: input.trim() ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  transition: 'background 0.15s',
                }}
              >
                <ArrowUpOutlined style={{ fontSize: 14 }} />
              </button>
            )}
          </div>
        </div>
          </div>
        </>
      )}
    </>
  );
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
  const bg = isUser ? '#6B8F71' : '#F8F4ED';
  const color = isUser ? '#FDFBF7' : '#2C2418';
  const running = !!message.toolStatus?.running || !!message.loading;
  // 助手消息且已完成（有正文、不在 loading）才显示操作按钮
  const showActions = !isUser && !running && !!message.content && !message.error;
  // 重新生成仅对最后一条助手消息显示
  const canRegenerate = showActions && isLast && !sending;

  const handleCopy = () => {
    navigator.clipboard
      .writeText(message.content)
      .then(() => antdMessage.success('已复制'))
      .catch(() => antdMessage.error('复制失败'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '9px 13px',
          borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
          background: bg,
          color,
          fontSize: 13.5,
          lineHeight: 1.6,
          wordBreak: 'break-word',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        {/* 中间过程：统一折叠成一行"执行中 Xs"，展开后按时序展示思考与工具 */}
        {!isUser && message.trace && message.trace.length > 0 && (
          <div style={{ marginBottom: message.content ? 8 : 0 }}>
            <TraceSummary trace={message.trace} running={running} startTime={message.startTime} />
          </div>
        )}
        {/* 内容：用户纯文本，助手 markdown（最终答案） */}
        {isUser ? (
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
        ) : message.error ? (
          <span style={{ color: '#C0564B' }}>{message.error}</span>
        ) : message.content ? (
          <div className="agent-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : message.loading ? (
          <span style={{ color: '#9A9080' }}>思考中…</span>
        ) : null}
      </div>
      {/* 助手消息的操作按钮（复制 / 重新生成） */}
      {showActions && (
        <div style={{ display: 'flex', gap: 4, marginTop: 3, marginRight: isUser ? 0 : 0, marginLeft: isUser ? 0 : 0 }}>
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
 * 中间过程的统一折叠条。
 * 收起时只占一行："执行中 Xs" / "已完成 · 用时 Xs"。
 * 展开后按真实时序逐项展示（思考过程 / 工具调用交织，各自可折叠，不合并）。
 */
function TraceSummary({
  trace,
  running,
  startTime,
}: {
  trace: import('./useChat').TraceItem[];
  running: boolean;
  startTime?: number;
}) {
  const [now, setNow] = useState(Date.now());

  // 执行中每秒刷新一次计时；完成后停止
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // 耗时（秒）：用 floor 避免四舍五入导致的跳变
  const elapsed = startTime ? Math.max(0, Math.floor((now - startTime) / 1000)) : 0;
  const label = running ? `执行中 ${elapsed}s` : `已完成 · 用时 ${elapsed}s`;
  // trace 最后一项是否正在流式写入（用于显示光标）
  const lastIdx = trace.length - 1;

  return (
    <CollapsibleBar
      icon={running ? <LoadingOutlined style={{ fontSize: 11 }} /> : undefined}
      label={label}
      defaultOpen={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {trace.map((item, i) =>
          item.type === 'thinking' ? (
            <CollapsibleBar key={i} label="思考过程" defaultOpen={false}>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: '#7A7060',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 240,
                  overflowY: 'auto',
                }}
              >
                {item.text}
                {running && i === lastIdx && <span style={{ color: '#9A9080' }}> ▍</span>}
              </div>
            </CollapsibleBar>
          ) : (
            <CollapsibleBar key={i} label={`工具调用 · ${item.text}`} defaultOpen={false}>
              <div style={{ fontSize: 12, lineHeight: 1.8, color: '#7A7060' }}>· {item.text}</div>
            </CollapsibleBar>
          ),
        )}
      </div>
    </CollapsibleBar>
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
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
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
      </div>
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
      <table style={{ borderCollapse: 'collapse', width: '100%', margin: '8px 0', fontSize: 12.5 }}>{children}</table>
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
