import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PatPage from '@client/pages/Pat';
import { patApi } from '@client/api/pat';

vi.mock('@client/api/pat', () => ({
  patApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  },
}));

describe('PAT 管理页面', () => {
  beforeEach(() => {
    vi.mocked(patApi.list).mockResolvedValue({
      code: 0,
      data: [{
        id: 1,
        userId: 1,
        name: '旧令牌',
        prefix: 'wpat_old123',
        scopes: null,
        lastUsedAt: null,
        expiresAt: '2020-01-01T00:00:00Z',
        createdAt: '2019-01-01T00:00:00Z',
        updatedAt: '2019-01-01T00:00:00Z',
      }],
    });
    vi.mocked(patApi.create).mockResolvedValue({
      code: 0,
      data: {
        id: 2,
        userId: 1,
        name: 'Cursor',
        prefix: 'wpat_new123',
        tokenPlain: 'wpat_1234567890abcdef1234567890abcdef',
        scopes: null,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: '2026-07-22T00:00:00Z',
        updatedAt: '2026-07-22T00:00:00Z',
      },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('标记已过期令牌，并明确说明内置 AI 不使用 PAT', async () => {
    render(<PatPage />);
    expect(await screen.findByText(/已过期 2020-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/内置 AI 助手使用服务端短期凭证/)).toBeInTheDocument();
    expect(screen.queryByText('wpat_1234567890abcdef1234567890abcdef')).not.toBeInTheDocument();
  });

  it('创建按钮不误称为自动复制，明文仅在二次弹窗展示一次', async () => {
    const user = userEvent.setup();
    render(<PatPage />);
    await user.click(screen.getByRole('button', { name: /新建令牌/ }));
    await user.type(screen.getByLabelText('令牌名称'), 'Cursor');

    const createButton = screen.getByRole('button', { name: /创\s*建\s*令\s*牌/ });
    expect(createButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /创建并复制/ })).not.toBeInTheDocument();
    await user.click(createButton);

    expect(await screen.findByText('访问令牌已创建')).toBeInTheDocument();
    expect(screen.getByDisplayValue('wpat_1234567890abcdef1234567890abcdef')).toBeInTheDocument();
    expect(patApi.create).toHaveBeenCalledWith({ name: 'Cursor', expiresAt: undefined });
  });

  it('列表加载失败时显示页内错误和重试入口', async () => {
    vi.mocked(patApi.list).mockRejectedValueOnce(new Error('令牌服务不可用'));
    render(<PatPage />);
    expect(await screen.findByText('令牌服务不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重 试' })).toBeInTheDocument();
  });

  it('把浏览器本地过期时间转换为带时区的 ISO 时间后提交', async () => {
    const user = userEvent.setup();
    render(<PatPage />);
    await user.click(screen.getByRole('button', { name: /新建令牌/ }));
    await user.type(screen.getByLabelText('令牌名称'), '定时脚本');
    await user.type(screen.getByLabelText('过期时间（可选）'), '2026-12-31T18:00');
    await user.click(screen.getByRole('button', { name: /创\s*建\s*令\s*牌/ }));

    await waitFor(() => expect(patApi.create).toHaveBeenCalledWith({
      name: '定时脚本',
      expiresAt: new Date('2026-12-31T18:00').toISOString(),
    }));
  });

  it('创建响应缺少一次性明文时明确提示删除重建，不误报可用', async () => {
    vi.mocked(patApi.create).mockResolvedValueOnce({
      code: 0,
      data: {
        id: 3, userId: 1, name: '异常令牌', prefix: 'wpat_missing', scopes: null,
        lastUsedAt: null, expiresAt: null, createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
    });
    const user = userEvent.setup();
    render(<PatPage />);
    await user.click(screen.getByRole('button', { name: /新建令牌/ }));
    await user.type(screen.getByLabelText('令牌名称'), '异常令牌');
    await user.click(screen.getByRole('button', { name: /创\s*建\s*令\s*牌/ }));

    expect(await screen.findByText(/未收到一次性明文/)).toBeInTheDocument();
    expect(screen.queryByText('访问令牌已创建')).not.toBeInTheDocument();
  });

  it('创建请求进行中不能关闭弹窗，避免成功后丢失一次性明文', async () => {
    let resolveCreate!: (value: any) => void;
    vi.mocked(patApi.create).mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));
    const user = userEvent.setup();
    render(<PatPage />);
    await user.click(screen.getByRole('button', { name: /新建令牌/ }));
    await user.type(screen.getByLabelText('令牌名称'), '慢请求');
    await user.click(screen.getByRole('button', { name: /创\s*建\s*令\s*牌/ }));

    const dialog = screen.getByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取 消' }));
    expect(dialog).toBeInTheDocument();

    resolveCreate({
      code: 0,
      data: {
        id: 4, userId: 1, name: '慢请求', prefix: 'wpat_slow', tokenPlain: 'wpat_slow-secret',
        scopes: null, lastUsedAt: null, expiresAt: null,
        createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
    });
    expect(await screen.findByDisplayValue('wpat_slow-secret')).toBeInTheDocument();
  });
});
