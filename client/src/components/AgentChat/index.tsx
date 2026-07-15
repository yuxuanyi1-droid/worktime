import { useState, useRef, useEffect } from 'react';
import { Drawer, Input, Button, Space, Tooltip } from 'antd';
import {
  RobotOutlined,
  CloseOutlined,
  SendOutlined,
  ClearOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChat } from './useChat';

/**
 * 全局悬浮 AI 助手。
 * 右下角浮动按钮 + 右侧抽屉聊天面板。
 * 走当前用户 JWT session 鉴权（不走 PAT），PAT 仅用于 skill 内部 curl。
 */
export default function AgentChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const { messages, sending, send, stop, clear } = useChat();
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息时自动滚到底
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    send(text);
    setInput('');
  };

  return (
    <>
      {/* 浮动按钮 */}
      {!open && (
        <div
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed',
            right: 32,
            bottom: 32,
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: '#6B8F71',
            color: '#FDFBF7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(107, 143, 113, 0.45)',
            zIndex: 1000,
            transition: 'transform 0.2s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          title="AI 助手"
        >
          <RobotOutlined style={{ fontSize: 26 }} />
        </div>
      )}

      {/* 聊天抽屉 */}
      <Drawer
        placement="right"
        open={open}
        onClose={() => setOpen(false)}
        width={420}
        closable={false}
        styles={{
          body: { padding: 0, display: 'flex', flexDirection: 'column', background: '#FDFBF7' },
          header: { display: 'none' },
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
          <Space>
            <RobotOutlined style={{ fontSize: 18 }} />
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
              <RobotOutlined style={{ fontSize: 36, color: '#6B8F71', marginBottom: 12, display: 'block' }} />
              你好，我是工时助手。可以问我：
              <div style={{ marginTop: 8, lineHeight: 1.8 }}>
                「我这周填了多少工时」<br />
                「我有几条待审批」<br />
                「我的加班统计」
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>

        {/* 输入区 */}
        <div style={{ borderTop: '1px solid #E8E0D4', padding: 12, flexShrink: 0, background: '#FDFBF7' }}>
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
            style={{ borderRadius: 10, borderColor: '#E8E0D4', marginBottom: 8 }}
            disabled={sending}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            {sending ? (
              <Button size="small" onClick={stop} icon={<CloseOutlined />}>停止</Button>
            ) : (
              <Button
                type="primary"
                size="small"
                onClick={handleSend}
                disabled={!input.trim()}
                icon={<SendOutlined />}
                style={{ background: '#6B8F71', borderColor: '#6B8F71' }}
              >
                发送
              </Button>
            )}
          </div>
        </div>
      </Drawer>
    </>
  );
}

/** 单条消息气泡 */
function MessageBubble({ message }: { message: import('./useChat').ChatMessage }) {
  const isUser = message.role === 'user';
  const align = isUser ? 'flex-end' : 'flex-start';
  const bg = isUser ? '#6B8F71' : '#F8F4ED';
  const color = isUser ? '#FDFBF7' : '#2C2418';
  const running = !!message.toolStatus?.running || !!message.loading;

  return (
    <div style={{ display: 'flex', justifyContent: align }}>
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ) : message.loading ? (
          <span style={{ color: '#9A9080' }}>思考中…</span>
        ) : null}
      </div>
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
