import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentChat from '@client/components/AgentChat';
import { agentApi } from '@client/api/agent';

const chat = vi.hoisted(() => ({
  messages: [] as any[],
  sessions: [] as any[],
  currentSessionId: undefined as string | undefined,
  sending: false,
  loadingSession: false,
  queuedMessages: [] as string[],
  initialize: vi.fn(async () => undefined),
  switchSession: vi.fn(async () => undefined),
  newSession: vi.fn(async () => undefined),
  renameSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  send: vi.fn(async () => true),
  stop: vi.fn(),
  regenerate: vi.fn(),
}));

vi.mock('@client/components/AgentChat/useChat', () => ({ useChat: () => chat }));
vi.mock('@client/api/agent', () => ({
  agentApi: { getStatus: vi.fn() },
}));

describe('AI 助手悬浮入口', () => {
  beforeEach(() => {
    chat.messages = [];
    chat.sessions = [];
    chat.currentSessionId = undefined;
    chat.sending = false;
    chat.loadingSession = false;
    chat.queuedMessages = [];
    chat.initialize.mockResolvedValue(undefined);
    chat.switchSession.mockResolvedValue(undefined);
    chat.newSession.mockResolvedValue(undefined);
    chat.renameSession.mockResolvedValue(undefined);
    chat.deleteSession.mockResolvedValue(undefined);
    chat.send.mockResolvedValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('服务端未配置 AI 时不展示一个必然失败的入口', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: false } });
    render(<AgentChat />);

    await waitFor(() => expect(agentApi.getStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: '打开 AI 助手' })).not.toBeInTheDocument();
  });

  it('AI 可用时入口可通过按钮打开并自动初始化会话', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    const user = userEvent.setup();
    render(<AgentChat />);

    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));

    expect(await screen.findByRole('complementary', { name: 'AI 工时助手' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭 AI 助手' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我这周填了多少工时' })).toBeInTheDocument();
    expect(screen.getByText('AI 仅执行只读查询，结果请以系统记录为准')).toBeInTheDocument();
    await waitFor(() => expect(chat.initialize).toHaveBeenCalled());
  });

  it('模型 Markdown 中的外部图片不会触发浏览器加载', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.messages = [{
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ id: 'text-1', type: 'text', text: '![敏感图](https://tracker.example/pixel)', done: true }],
      loading: false,
    }];
    const user = userEvent.setup();
    const { container } = render(<AgentChat />);

    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));

    expect(await screen.findByText('[图片已隐藏：敏感图]')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('输入内容可通过发送按钮提交，失败时恢复原输入供用户重试', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.send
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('模型暂不可用'));
    const user = userEvent.setup();
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));

    const input = screen.getByPlaceholderText('输入问题，Enter 发送');
    await user.type(input, '查询本周工时');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    expect(chat.send).toHaveBeenLastCalledWith('查询本周工时');
    expect(input).toHaveValue('');

    await user.type(input, '失败后保留');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(input).toHaveValue('失败后保留'));
  });

  it('发送中允许继续排队和停止当前回答', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.sending = true;
    chat.queuedMessages = ['第一条', '第二条'];
    const user = userEvent.setup();
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));

    expect(screen.getByText('已排队 2 条：第二条')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '停止当前回答' }));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    const input = screen.getByPlaceholderText('继续输入，发送后将排队处理');
    await user.type(input, '追加问题');
    await user.click(screen.getByRole('button', { name: '将消息加入队列' }));
    expect(chat.send).toHaveBeenCalledWith('追加问题');
  });

  it('快捷建议直接发送，新建对话失败不会关闭当前面板', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.newSession.mockRejectedValueOnce(new Error('新建失败'));
    const user = userEvent.setup();
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));

    await user.click(screen.getByRole('button', { name: '统计一下本月加班' }));
    expect(chat.send).toHaveBeenCalledWith('统计一下本月加班');
    await user.click(screen.getByRole('button', { name: '新建对话' }));
    await waitFor(() => expect(chat.newSession).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('complementary', { name: 'AI 工时助手' })).toBeInTheDocument();
  });

  it('历史对话支持切换和重命名', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.currentSessionId = 'session-1';
    chat.sessions = [
      { id: 'session-1', title: '本周工时', updatedAt: new Date().toISOString(), messageCount: 2 },
      { id: 'session-2', title: '加班统计', updatedAt: '2026-07-01T08:00:00.000Z', messageCount: 4 },
    ];
    const user = userEvent.setup();
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));
    await user.click(screen.getByRole('button', { name: '查看最近对话' }));

    await user.click((await screen.findByText('加班统计')).closest('button')!);
    await waitFor(() => expect(chat.switchSession).toHaveBeenCalledWith('session-2'));

    await user.click(screen.getByRole('button', { name: '查看最近对话' }));
    await user.click(await screen.findByRole('button', { name: '重命名 本周工时' }));
    const renameInput = screen.getByDisplayValue('本周工时');
    await user.clear(renameInput);
    await user.type(renameInput, '七月工时');
    await user.tab();
    await waitFor(() => expect(chat.renameSession).toHaveBeenCalledWith('session-1', '七月工时'));
  });

  it('删除历史对话前要求二次确认', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.sessions = [{
      id: 'session-2', title: '加班统计', updatedAt: '2026-07-01T08:00:00.000Z', messageCount: 4,
    }];
    const user = userEvent.setup();
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));
    await user.click(screen.getByRole('button', { name: '查看最近对话' }));
    await user.click(await screen.findByRole('button', { name: '删除 加班统计' }));
    expect(await screen.findByText('删除这条对话？')).toBeInTheDocument();
    const confirmDelete = screen.getAllByRole('button').find(button => (
      button.textContent?.replace(/\s/g, '') === '删除'
    ));
    expect(confirmDelete).toBeTruthy();
    await user.click(confirmDelete!);
    await waitFor(() => expect(chat.deleteSession).toHaveBeenCalledWith('session-2'));
  });

  it('回答只复制最终正文，支持重新生成并安全处理链接和执行过程', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    chat.messages = [{
      id: 'assistant-rich',
      role: 'assistant',
      startTime: Date.now() - 2000,
      parts: [
        { id: 'thinking', type: 'thinking', text: '不应展示的原始推理', done: true },
        { id: 'tool', type: 'tool', text: '查询工时', detail: '返回 5 天', status: 'success', done: true },
        { id: 'final', type: 'text', text: '最终 **5 天**。[站内](/timesheet) [外部](https://example.com) [危险](javascript:alert(1))\n\n```sql\nselect 1;\n```', done: true },
      ],
      loading: false,
    }];
    const user = userEvent.setup();
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { container } = render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));

    expect(await screen.findByText('5 天')).toBeInTheDocument();
    expect(screen.queryByText('不应展示的原始推理')).not.toBeInTheDocument();
    const external = screen.getByRole('link', { name: '外部' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('危险').closest('a')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: /已完成/ }));
    await user.click(screen.getByRole('button', { name: /问题分析完成/ }));
    await user.click(screen.getByRole('button', { name: /查询工时完成/ }));
    expect(screen.getByText('返回 5 天')).toBeInTheDocument();
    expect(screen.getByText('已确定下一步：查询工时。')).toBeInTheDocument();
    expect(screen.queryByText('AI 已完成内部分析，原始推理内容不会展示。')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '复制回答' }));
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('最终 **5 天**'));
    await user.click(screen.getByRole('button', { name: '重新生成回答' }));
    expect(chat.regenerate).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /复制$/ }));
    expect(clipboardWrite).toHaveBeenCalledWith('select 1;');
  });

  it('Escape 可关闭面板并恢复悬浮入口', async () => {
    vi.mocked(agentApi.getStatus).mockResolvedValue({ code: 0, data: { enabled: true } });
    const user = userEvent.setup();
    render(<AgentChat />);
    await user.click(await screen.findByRole('button', { name: '打开 AI 助手' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'AI 工时助手' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 AI 助手' })).toBeInTheDocument();
  });
});
