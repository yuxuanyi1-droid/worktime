import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import TimesheetPage from '@client/pages/Timesheet';
import { timesheetApi } from '@client/api/timesheet';
import { systemApi } from '@client/api/system';
import { approvalApi } from '@client/api/approval';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/timesheet', () => ({
  timesheetApi: {
    getMy: vi.fn(),
    delete: vi.fn(),
    batchCreate: vi.fn(),
    replaceWeekDrafts: vi.fn(),
    submitByRows: vi.fn(),
    modifySubmitted: vi.fn(),
  },
}));

vi.mock('@client/api/system', () => ({
  systemApi: {
    getActiveProjects: vi.fn(),
    getSettings: vi.fn(),
  },
}));

vi.mock('@client/api/approval', () => ({
  approvalApi: { withdraw: vi.fn() },
}));

const project = { id: 3, name: '工时项目', code: 'WT', status: 'active' };
const weekRecords = Array.from({ length: 5 }, (_, index) => ({
  id: 20 + index,
  userId: 1,
  projectId: 3,
  project,
  date: `2026-07-${20 + index}`,
  days: 1,
  description: '已有草稿',
  status: 'draft' as const,
  currentStep: 0,
  totalSteps: 0,
  submissionGroupId: null,
  createdAt: '2026-07-22T08:00:00Z',
  updatedAt: '2026-07-22T08:00:00Z',
}));

function setUser(permissions: string[]) {
  useAuthStore.setState({
    token: 'timesheet-token',
    user: {
      id: 1,
      username: 'timesheet-user',
      realName: '工时用户',
      department: null,
      group: null,
      roles: [],
      permissions,
    },
  });
}

describe('工时页面', () => {
  beforeEach(() => {
    vi.mocked(systemApi.getActiveProjects).mockResolvedValue({ code: 0, data: [project] } as any);
    vi.mocked(systemApi.getSettings).mockResolvedValue({
      code: 0, data: { settings: { timesheet_unit: '0.5' } },
    } as any);
    vi.mocked(timesheetApi.getMy).mockResolvedValue({
      code: 0,
      data: { list: weekRecords, total: weekRecords.length, page: 1, pageSize: 200 },
    } as any);
    vi.mocked(timesheetApi.replaceWeekDrafts).mockResolvedValue({ code: 0 } as any);
    vi.mocked(timesheetApi.submitByRows).mockResolvedValue({ code: 0 } as any);
    vi.mocked(timesheetApi.modifySubmitted).mockResolvedValue({ code: 0 } as any);
    vi.mocked(timesheetApi.delete).mockResolvedValue({ code: 0 } as any);
    vi.mocked(approvalApi.withdraw).mockResolvedValue({ code: 0 } as any);
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('只有查看权限时仍展示草稿，但不展示会导致 403 的编辑操作', async () => {
    setUser(['timesheet:access', 'timesheet:view:self']);
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    expect((await screen.findAllByText('已有草稿')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /保存草稿/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /复制上周/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加项目行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('保存草稿使用单个原子替换请求，不再先删除旧数据', async () => {
    setUser([
      'timesheet:access', 'timesheet:view:self', 'timesheet:create',
      'timesheet:delete:self', 'timesheet:submit:self',
    ]);
    const user = userEvent.setup();
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /保存草稿/ }));
    await waitFor(() => expect(timesheetApi.replaceWeekDrafts).toHaveBeenCalledTimes(1));
    expect(timesheetApi.replaceWeekDrafts).toHaveBeenCalledWith('2026-07-20', expect.arrayContaining([
      expect.objectContaining({ projectId: 3, date: '2026-07-20', days: 1, description: '已有草稿' }),
    ]));
    expect(timesheetApi.delete).not.toHaveBeenCalled();
    expect(timesheetApi.batchCreate).not.toHaveBeenCalled();
  });

  it('即使没有进行中项目，也会加载并展示本周已有工时', async () => {
    setUser(['timesheet:access', 'timesheet:view:self']);
    vi.mocked(systemApi.getActiveProjects).mockResolvedValue({ code: 0, data: [] } as any);
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    expect((await screen.findAllByText('已有草稿')).length).toBeGreaterThan(0);
    expect(timesheetApi.getMy).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-07-20', endDate: '2026-07-26',
    }));
  });

  it('只有编辑权限也能修改已审批工时并重新发起审批', async () => {
    setUser(['timesheet:access', 'timesheet:view:self', 'timesheet:update:self']);
    vi.mocked(timesheetApi.getMy).mockResolvedValue({
      code: 0,
      data: {
        list: weekRecords.map((record) => ({
          ...record,
          status: 'approved' as const,
          submissionGroupId: 10,
          currentStep: 0,
          totalSteps: 1,
        })),
        total: 5,
        page: 1,
        pageSize: 200,
      },
    } as any);
    const user = userEvent.setup();
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /修改工时/ }));
    const description = await screen.findByPlaceholderText('工作内容（支持换行）');
    await user.clear(description);
    await user.type(description, '修改后的工作内容');
    await user.click(screen.getByRole('button', { name: /保存修改并重新提交/ }));

    await waitFor(() => expect(timesheetApi.modifySubmitted).toHaveBeenCalledWith([expect.objectContaining({
      projectId: 3,
      description: '修改后的工作内容',
      weekStart: '2026-07-20',
      entries: expect.arrayContaining([{ date: '2026-07-20', days: 1 }]),
    })]));
    expect(timesheetApi.submitByRows).not.toHaveBeenCalled();
  });

  it('撤回审批后保留当前周内容进入编辑，不会显示成空白周', async () => {
    setUser([
      'timesheet:access', 'timesheet:view:self', 'timesheet:update:self',
      'approval:withdraw:self',
    ]);
    vi.mocked(timesheetApi.getMy).mockResolvedValue({
      code: 0,
      data: {
        list: weekRecords.map((record) => ({
          ...record,
          status: 'submitted' as const,
          submissionGroupId: 12,
          currentStep: 1,
          totalSteps: 1,
        })),
        total: 5,
        page: 1,
        pageSize: 200,
      },
    } as any);
    const user = userEvent.setup();
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /撤回修改/ }));
    const confirm = document.querySelector('.ant-modal-confirm .ant-btn-primary');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);

    await waitFor(() => expect(approvalApi.withdraw).toHaveBeenCalledWith('timesheet', 20));
    expect(await screen.findByDisplayValue('已有草稿')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存修改并重新提交/ })).toBeInTheDocument();
  });

  it('提交整周草稿前确认，并按项目行发送完整周数据', async () => {
    setUser([
      'timesheet:access', 'timesheet:view:self', 'timesheet:create', 'timesheet:submit:self',
    ]);
    const user = userEvent.setup();
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /提交审批/ }));
    expect(await screen.findByText(/即将提交/)).toBeInTheDocument();
    const confirm = document.querySelector('.ant-modal-confirm .ant-btn-primary');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);

    await waitFor(() => expect(timesheetApi.submitByRows).toHaveBeenCalledWith([expect.objectContaining({
      projectId: 3,
      weekStart: '2026-07-20',
      entries: expect.any(Array),
    })]));
  });

  it('允许直接删除当前周仅剩的一行已保存草稿', async () => {
    setUser(['timesheet:access', 'timesheet:view:self', 'timesheet:delete:self']);
    const user = userEvent.setup();
    render(<MemoryRouter><TimesheetPage /></MemoryRouter>);

    expect((await screen.findAllByText('已有草稿')).length).toBeGreaterThan(0);
    const deleteButtons = await screen.findAllByRole('button', { name: /delete|删除/i });
    const weekDelete = deleteButtons.find((button) => (
      button.querySelector('[aria-label="delete"]') && !button.hasAttribute('disabled')
    ));
    expect(weekDelete).toBeDefined();
    await user.click(weekDelete!);
    const confirm = document.querySelector('.ant-popconfirm-buttons .ant-btn-primary');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);

    await waitFor(() => expect(timesheetApi.delete).toHaveBeenCalledTimes(5));
  });
});
