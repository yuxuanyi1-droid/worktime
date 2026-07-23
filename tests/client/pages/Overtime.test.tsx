import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Overtime from '@client/pages/Overtime';
import { overtimeApi } from '@client/api/overtime';
import { systemApi } from '@client/api/system';
import { approvalApi } from '@client/api/approval';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/overtime', () => ({
  overtimeApi: {
    getMy: vi.fn(),
    update: vi.fn(),
    submit: vi.fn(),
    delete: vi.fn(),
    createAndSubmit: vi.fn(),
  },
}));

vi.mock('@client/api/system', () => ({
  systemApi: { getActiveProjects: vi.fn() },
}));

vi.mock('@client/api/approval', () => ({
  approvalApi: { withdraw: vi.fn() },
}));

describe('加班页面', () => {
  beforeEach(() => {
    useAuthStore.setState({
      token: 'token',
      user: {
        id: 1,
        username: 'tester',
        realName: '测试用户',
        department: null,
        group: null,
        roles: [],
        permissions: [
          'overtime:view:self', 'overtime:create', 'overtime:update:self',
          'overtime:submit:self', 'overtime:delete:self', 'approval:withdraw:self',
        ],
      },
    });
    vi.mocked(systemApi.getActiveProjects).mockResolvedValue({
      code: 0,
      data: [{ id: 3, name: '工时项目', code: 'WT' }],
    });
    vi.mocked(overtimeApi.getMy).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 8,
          userId: 1,
          projectId: 3,
          project: { id: 3, name: '工时项目' },
          date: '2026-07-20',
          overtimeType: 'weekday',
          days: 0.5,
          reason: '上线支持',
          status: 'rejected',
          currentStep: 0,
          totalSteps: 1,
          createdAt: '2026-07-20T00:00:00Z',
          updatedAt: '2026-07-20T00:00:00Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('驳回记录提供修改并重提入口，并回填原申请', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Overtime /></MemoryRouter>);
    const edit = await screen.findByRole('button', { name: /修改并重提/ });
    await user.click(edit);

    expect(await screen.findByText('修改加班申请')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('上线支持')).toBeInTheDocument());
    const days = screen.getByRole('spinbutton');
    expect(days).toHaveAttribute('aria-valuemax', '1');
    expect(days).toHaveValue('0.5');
  });

  it('使用服务端分页，超过 100 条的记录仍可访问', async () => {
    vi.mocked(overtimeApi.getMy)
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 45, page: 1, pageSize: 20 } })
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 45, page: 2, pageSize: 20 } });
    const user = userEvent.setup();
    render(<MemoryRouter><Overtime /></MemoryRouter>);

    await waitFor(() => expect(overtimeApi.getMy).toHaveBeenCalledWith({ page: 1, pageSize: 20 }));
    await user.click(await screen.findByTitle('2'));
    await waitFor(() => expect(overtimeApi.getMy).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 }));
  });

  it('删除草稿与撤回审批分别调用对应接口并刷新列表', async () => {
    vi.mocked(overtimeApi.getMy).mockResolvedValue({
      code: 0,
      data: {
        list: [
          {
            id: 10, userId: 1, projectId: 3, project: { id: 3, name: '工时项目' },
            date: '2026-07-21', overtimeType: 'weekday', days: 0.5, reason: '草稿',
            status: 'draft', currentStep: 0, totalSteps: 1, createdAt: '', updatedAt: '',
          },
          {
            id: 11, userId: 1, projectId: 3, project: { id: 3, name: '工时项目' },
            date: '2026-07-22', overtimeType: 'weekday', days: 0.5, reason: '审批中',
            status: 'submitted', currentStep: 1, totalSteps: 1, createdAt: '', updatedAt: '',
          },
        ],
        total: 2, page: 1, pageSize: 20,
      },
    });
    vi.mocked(overtimeApi.delete).mockResolvedValue({ code: 0 });
    vi.mocked(approvalApi.withdraw).mockResolvedValue({ code: 0 });
    const user = userEvent.setup();
    render(<MemoryRouter><Overtime /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: '删除' }));
    let deleteConfirm: HTMLElement | null = null;
    await waitFor(() => {
      deleteConfirm = document.querySelector('.ant-popconfirm-buttons .ant-btn-primary');
      expect(deleteConfirm).not.toBeNull();
    });
    fireEvent.click(deleteConfirm!);
    await waitFor(() => expect(overtimeApi.delete).toHaveBeenCalledWith(10));

    await user.click(screen.getByRole('button', { name: '撤回' }));
    let withdrawConfirm: HTMLElement | null = null;
    await waitFor(() => {
      const candidates = document.querySelectorAll('.ant-popconfirm-buttons .ant-btn-primary');
      withdrawConfirm = candidates[candidates.length - 1] as HTMLElement | null;
      expect(withdrawConfirm).not.toBeNull();
    });
    fireEvent.click(withdrawConfirm!);
    await waitFor(() => expect(approvalApi.withdraw).toHaveBeenCalledWith('overtime', 11));
  });

  it('只有查看权限时不加载项目，也不展示写操作入口', async () => {
    useAuthStore.setState({
      token: 'token',
      user: {
        id: 1, username: 'viewer', realName: '只读用户', department: null, group: null,
        roles: [], permissions: ['overtime:view:self'],
      },
    });
    render(<MemoryRouter><Overtime /></MemoryRouter>);
    await waitFor(() => expect(overtimeApi.getMy).toHaveBeenCalled());
    expect(systemApi.getActiveProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /新增加班/ })).not.toBeInTheDocument();
  });
});
