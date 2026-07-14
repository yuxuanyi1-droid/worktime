import { useState, useRef, useEffect } from 'react';
import { Drawer, Input, Button, Space, Tooltip } from 'antd';
import { RobotOutlined, CloseOutlined, SendOutlined, ClearOutlined, LoadingOutlined } from '@ant-design/icons';
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
        {/* 工具状态提示 */}
        {message.toolStatus?.running && (
          <div style={{ fontSize: 12, color: isUser ? 'rgba(253,251,247,0.85)' : '#7A7060', marginBottom: 4, fontStyle: 'italic' }}>
            <LoadingOutlined style={{ marginRight: 4 }} />
            {message.toolStatus.toolName}…
          </div>
        )}
        {/* 内容：用户纯文本，助手 markdown */}
        {isUser ? (
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
        ) : message.error ? (
          <span style={{ color: '#C0564B' }}>{message.error}</span>
        ) : message.content ? (
          <div className="agent-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ) : message.loading ? (
          <span style={{ color: isUser ? 'rgba(253,251,247,0.85)' : '#9A9080' }}>思考中…</span>
        ) : null}
      </div>
    </div>
  );
}
