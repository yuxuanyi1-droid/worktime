import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ApprovalPage, { ApprovalDetailPage, getApprovalShareUrl } from '@client/pages/Approval';
import { approvalApi } from '@client/api/approval';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/approval', () => ({
  approvalApi: {
    getPending: vi.fn(),
    approve: vi.fn(),
    getHistory: vi.fn(),
    getMySubmissions: vi.fn(),
    getDetail: vi.fn(),
    withdraw: vi.fn(),
    cc: vi.fn(),
    getUsers: vi.fn(),
    getMyCc: vi.fn(),
  },
}));

function setPermissions(permissions: string[]) {
  useAuthStore.setState({
    token: 'approval-token',
    user: {
      id: 2,
      username: 'approver',
      realName: '审批人甲',
      department: null,
      group: null,
      roles: [],
      permissions,
    },
  });
}

const emptyPage = { code: 0, data: { list: [], total: 0, page: 1, pageSize: 20 } };

describe('审批中心页面', () => {
  beforeEach(() => {
    setPermissions([]);
    vi.mocked(approvalApi.getMySubmissions).mockResolvedValue(emptyPage);
    vi.mocked(approvalApi.getPending).mockResolvedValue(emptyPage);
    vi.mocked(approvalApi.getHistory).mockResolvedValue(emptyPage);
    vi.mocked(approvalApi.getMyCc).mockResolvedValue(emptyPage);
    vi.mocked(approvalApi.approve).mockResolvedValue({ code: 0 });
    vi.mocked(approvalApi.getUsers).mockResolvedValue({ code: 0, data: [] });
  });

  it('我的申请使用服务端分页，并只展示有权限的审批页签', async () => {
    vi.mocked(approvalApi.getMySubmissions)
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 45, page: 1, pageSize: 20 } })
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 45, page: 2, pageSize: 20 } });
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalPage /></MemoryRouter>);

    expect(await screen.findByRole('tab', { name: '我的申请' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '待审批' })).not.toBeInTheDocument();
    await waitFor(() => expect(approvalApi.getMySubmissions).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      status: undefined,
      targetType: undefined,
      startDate: undefined,
      endDate: undefined,
    }));

    await user.click(await screen.findByTitle('2'));
    await waitFor(() => expect(approvalApi.getMySubmissions).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 2,
      pageSize: 20,
    })));
  });

  it('会签详情展示每名审批人的真实状态和周报总工时', async () => {
    setPermissions(['approval:approve:assigned']);
    vi.mocked(approvalApi.getDetail).mockResolvedValue({
      code: 0,
      data: {
        content: {
          targetType: 'weekly_report',
          targetId: 7,
          status: 'submitted',
          currentStep: 1,
          totalSteps: 1,
          applicant: { id: 1, name: '申请人', department: '研发部', group: '一组' },
          createdAt: '2026-07-22T08:00:00.000Z',
          updatedAt: '2026-07-22T08:00:00.000Z',
          weekStart: '2026-07-20',
          weekEnd: '2026-07-26',
          totalDays: 4.5,
          content: '完成审批优化',
          summary: '本周完成',
        },
        flowSteps: [{
          stepOrder: 1,
          stepType: 'project_manager',
          label: '项目管理员会签',
          approverIds: [2, 3],
          approverNames: ['审批人甲', '审批人乙'],
          approverName: '审批人甲',
          status: 'current',
          action: 'approve',
          comment: '同意',
          approvedAt: '2026-07-22T09:00:00.000Z',
          requireAllApprovers: true,
          approverStatuses: [
            { id: 2, name: '审批人甲', status: 'approved', action: 'approve', comment: '同意', actedAt: '2026-07-22T09:00:00.000Z' },
            { id: 3, name: '审批人乙', status: 'pending', action: null, comment: null, actedAt: null },
          ],
        }],
        records: [],
        viewerContext: { isApplicant: false, isCurrentApprover: true, isAdmin: false, isCcRecipient: false },
      },
    });
    render(
      <MemoryRouter initialEntries={['/approval/detail/weekly_report/7']}>
        <Routes><Route path="/approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('4.5天')).toBeInTheDocument();
    expect(screen.getByText('会签')).toBeInTheDocument();
    expect(screen.getAllByText('已通过').length).toBeGreaterThan(0);
    expect(screen.getByText('待处理')).toBeInTheDocument();
  });

  it('前端阻止无原因驳回，填写原因后才提交', async () => {
    setPermissions(['approval:approve:assigned']);
    vi.mocked(approvalApi.getDetail).mockResolvedValue({
      code: 0,
      data: {
        content: {
          targetType: 'weekly_report', targetId: 7, status: 'submitted', currentStep: 1, totalSteps: 1,
          applicant: { id: 1, name: '申请人', department: null, group: null },
          createdAt: '2026-07-22T08:00:00.000Z', updatedAt: '2026-07-22T08:00:00.000Z',
          totalDays: 5,
        },
        flowSteps: [{
          stepOrder: 1, stepType: 'custom', label: '负责人审批', approverIds: [2], approverNames: ['审批人甲'],
          approverName: '审批人甲', status: 'current', action: null, comment: null, approvedAt: null,
        }],
        records: [],
        viewerContext: { isApplicant: false, isCurrentApprover: true, isAdmin: false, isCcRecipient: false },
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/approval/detail/weekly_report/7']}>
        <Routes><Route path="/approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /驳回/ }));
    expect(await screen.findByText('驳回时请填写原因')).toBeInTheDocument();
    expect(approvalApi.approve).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('通过意见（可选）；驳回原因（必填）'), '信息不完整');
    await user.click(screen.getByRole('button', { name: /驳回/ }));
    await waitFor(() => expect(approvalApi.approve).toHaveBeenCalledWith([{
      targetType: 'weekly_report',
      targetId: 7,
      action: 'reject',
      comment: '信息不完整',
    }]));
  });

  it('待审批列表支持勾选后批量通过并刷新列表', async () => {
    setPermissions(['approval:view:todo', 'approval:approve:assigned']);
    vi.mocked(approvalApi.getPending).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          targetType: 'overtime',
          targetId: 8,
          taskId: 108,
          title: '版本发布加班',
          applicant: '申请人',
          department: '研发部',
          days: 0.5,
          currentStep: 1,
          totalSteps: 1,
          currentStepLabel: '负责人审批',
          currentStepApprover: '审批人甲',
          createdAt: '2026-07-22T08:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalPage /></MemoryRouter>);

    await user.click(screen.getByRole('tab', { name: '待审批' }));
    await waitFor(() => expect(approvalApi.getPending).toHaveBeenCalledWith({ page: 1, pageSize: 20 }));
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[checkboxes.length - 1]);
    await user.click(screen.getByRole('button', { name: /批量通过 \(1\)/ }));

    await waitFor(() => expect(approvalApi.approve).toHaveBeenCalledWith([{
      targetType: 'overtime',
      targetId: 8,
      action: 'approve',
      comment: '',
    }]));
    await waitFor(() => expect(approvalApi.getPending).toHaveBeenCalledTimes(2));
  });

  it('详情加载失败保留错误信息并支持重试', async () => {
    setPermissions([]);
    vi.mocked(approvalApi.getDetail)
      .mockRejectedValueOnce({ response: { data: { message: '审批记录暂时不可用' } } })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          content: {
            targetType: 'weekly_report', targetId: 7, status: 'approved', currentStep: 0, totalSteps: 1,
            applicant: { id: 1, name: '申请人', department: null, group: null },
            createdAt: '2026-07-22T08:00:00.000Z', updatedAt: '2026-07-22T08:00:00.000Z',
          },
          flowSteps: [],
          records: [],
          viewerContext: { isApplicant: true, isCurrentApprover: false, isAdmin: false, isCcRecipient: false },
        },
      });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/approval/detail/weekly_report/7']}>
        <Routes><Route path="/approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('审批记录暂时不可用')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(await screen.findByText('该申请已审批通过')).toBeInTheDocument();
    expect(approvalApi.getDetail).toHaveBeenCalledTimes(2);
  });

  it('任务已分配但缺少处理权限时给出明确说明', async () => {
    setPermissions(['approval:view:todo']);
    vi.mocked(approvalApi.getDetail).mockResolvedValue({
      code: 0,
      data: {
        content: {
          targetType: 'overtime', targetId: 8, status: 'submitted', currentStep: 1, totalSteps: 1,
          applicant: { id: 1, name: '申请人', department: null, group: null },
          createdAt: '2026-07-22T08:00:00.000Z', updatedAt: '2026-07-22T08:00:00.000Z',
        },
        flowSteps: [{
          stepOrder: 1, stepType: 'custom', label: '负责人审批', approverIds: [2], approverNames: ['审批人甲'],
          approverName: '审批人甲', status: 'current', action: null, comment: null, approvedAt: null,
        }],
        records: [],
        viewerContext: { isApplicant: false, isCurrentApprover: true, isAdmin: false, isCcRecipient: false },
      },
    });
    render(
      <MemoryRouter initialEntries={['/approval/detail/overtime/8']}>
        <Routes><Route path="/approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('该审批已分配给您，但当前角色没有审批处理权限')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /通过/ })).not.toBeInTheDocument();
  });

  it('申请人可以二次确认后撤回仍在审批中的申请', async () => {
    setPermissions(['approval:withdraw:self']);
    vi.mocked(approvalApi.getDetail).mockResolvedValue({
      code: 0,
      data: {
        content: {
          targetType: 'overtime', targetId: 8, status: 'submitted', currentStep: 1, totalSteps: 1,
          applicant: { id: 2, name: '审批人甲', department: null, group: null },
          createdAt: '2026-07-22T08:00:00.000Z', updatedAt: '2026-07-22T08:00:00.000Z',
        },
        flowSteps: [{
          stepOrder: 1, stepType: 'custom', label: '负责人审批', approverIds: [3], approverNames: ['审批人乙'],
          approverName: '审批人乙', status: 'current', action: null, comment: null, approvedAt: null,
        }],
        records: [],
        viewerContext: { isApplicant: true, isCurrentApprover: false, isAdmin: false, isCcRecipient: false },
      },
    });
    vi.mocked(approvalApi.withdraw).mockResolvedValue({ code: 0 } as any);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/approval/detail/overtime/8']}>
        <Routes><Route path="/approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /撤回/ }));
    expect(await screen.findByText('确定撤回此申请？')).toBeInTheDocument();
    const confirm = screen.getAllByRole('button').find(button => /确\s*定|OK/i.test(button.textContent || ''));
    expect(confirm).toBeTruthy();
    await user.click(confirm!);
    await waitFor(() => expect(approvalApi.withdraw).toHaveBeenCalledWith('overtime', 8));
  });

  it('申请人抄送时从候选人目录选择用户并提交工号对应用户 ID', async () => {
    setPermissions([]);
    vi.mocked(approvalApi.getDetail).mockResolvedValue({
      code: 0,
      data: {
        content: {
          targetType: 'weekly_report', targetId: 7, status: 'submitted', currentStep: 1, totalSteps: 1,
          applicant: { id: 2, name: '审批人甲', department: null, group: null },
          createdAt: '2026-07-22T08:00:00.000Z', updatedAt: '2026-07-22T08:00:00.000Z',
        },
        flowSteps: [{
          stepOrder: 1, stepType: 'custom', label: '负责人审批', approverIds: [3], approverNames: ['审批人乙'],
          approverName: '审批人乙', status: 'current', action: null, comment: null, approvedAt: null,
        }],
        records: [],
        viewerContext: { isApplicant: true, isCurrentApprover: false, isAdmin: false, isCcRecipient: false },
      },
    });
    vi.mocked(approvalApi.getUsers).mockResolvedValue({
      code: 0, data: [{ id: 5, realName: '抄送用户', department: '研发部' }],
    });
    vi.mocked(approvalApi.cc).mockResolvedValue({ code: 0 } as any);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/approval/detail/weekly_report/7']}>
        <Routes><Route path="/approval/detail/:targetType/:targetId" element={<ApprovalDetailPage />} /></Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /抄送传阅/ }));
    await waitFor(() => expect(approvalApi.getUsers).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByText('抄送用户（研发部）'));
    const ok = screen.getAllByRole('button').find(button => /确\s*定|OK/i.test(button.textContent || ''));
    expect(ok).toBeTruthy();
    await user.click(ok!);
    await waitFor(() => expect(approvalApi.cc).toHaveBeenCalledWith('weekly_report', 7, [5]));
  });

  it('分享链接使用当前站点 origin 和部署基础路径', () => {
    expect(getApprovalShareUrl('timesheet', 12)).toBe(`${window.location.origin}/approval/detail/timesheet/12`);
  });
});
