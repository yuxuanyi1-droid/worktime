import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WeeklyReportPage from '@client/pages/WeeklyReport';
import { weeklyReportApi } from '@client/api/weeklyReport';
import { timesheetApi } from '@client/api/timesheet';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/weeklyReport', () => ({
  weeklyReportApi: {
    getByWeek: vi.fn(),
    save: vi.fn(),
    submit: vi.fn(),
  },
}));

vi.mock('@client/api/timesheet', () => ({
  timesheetApi: {
    getWeeklySummary: vi.fn(),
    getMy: vi.fn(),
  },
}));

const report = {
  id: 9,
  userId: 1,
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  content: '<strong>旧周报</strong><br><img src=x onerror=alert(1)>安全内容',
  summary: '旧摘要',
  totalDays: 4,
  status: 'rejected' as const,
  currentStep: 0,
  totalSteps: 1,
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:00Z',
};

describe('周报页面', () => {
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
          'weekly_report:view:self', 'weekly_report:create', 'weekly_report:submit:self',
          'timesheet:view:self',
        ],
      },
    });
    vi.mocked(weeklyReportApi.getByWeek).mockResolvedValue({ code: 0, data: report });
    vi.mocked(timesheetApi.getWeeklySummary).mockResolvedValue({
      code: 0,
      data: { totalDays: 4, byProject: { 工时项目: 4 }, records: [] },
    } as any);
    vi.mocked(weeklyReportApi.save).mockResolvedValue({
      code: 0,
      data: { ...report, content: '修改后的周报', status: 'draft' },
    });
    vi.mocked(weeklyReportApi.submit).mockResolvedValue({ code: 0 });
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('把历史 HTML 安全降级为纯文本，驳回后仍可编辑', async () => {
    render(<WeeklyReportPage />);
    const editor = await screen.findByPlaceholderText('请编写本周工作总结...');
    expect(editor).toHaveValue('旧周报\n安全内容');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('已驳回')).toBeInTheDocument();
    expect(editor).not.toBeDisabled();
  });

  it('点击提交时先保存当前内容，再提交返回的记录', async () => {
    const user = userEvent.setup();
    render(<WeeklyReportPage />);
    const editor = await screen.findByPlaceholderText('请编写本周工作总结...');
    await user.clear(editor);
    await user.type(editor, '修改后的周报');
    await user.click(screen.getByRole('button', { name: /提交审批/ }));

    await waitFor(() => expect(weeklyReportApi.submit).toHaveBeenCalledWith(9));
    expect(weeklyReportApi.save).toHaveBeenCalledWith(expect.objectContaining({
      content: '修改后的周报',
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
    }));
    expect(vi.mocked(weeklyReportApi.save).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(weeklyReportApi.submit).mock.invocationCallOrder[0]);
  });

  it('工时汇总失败不影响周报内容加载，并清空旧汇总', async () => {
    vi.mocked(timesheetApi.getWeeklySummary).mockRejectedValue({
      response: { data: { message: '工时汇总服务暂不可用' } },
    });
    render(<WeeklyReportPage />);

    const editor = await screen.findByPlaceholderText('请编写本周工作总结...');
    await waitFor(() => expect(editor).toHaveValue('旧周报\n安全内容'));
    expect(screen.getByText('工时汇总服务暂不可用')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('切周加载失败时不保留上一周内容，并提供重试入口', async () => {
    vi.mocked(weeklyReportApi.getByWeek)
      .mockResolvedValueOnce({ code: 0, data: report })
      .mockRejectedValueOnce({ response: { data: { message: '下一周周报加载失败' } } });
    const user = userEvent.setup();
    render(<WeeklyReportPage />);

    const editor = await screen.findByPlaceholderText('请编写本周工作总结...');
    await waitFor(() => expect(editor).toHaveValue('旧周报\n安全内容'));
    await user.click(screen.getByRole('button', { name: '下一周' }));

    expect(await screen.findByText('下一周周报加载失败')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('请编写本周工作总结...')).toHaveValue('');
    expect(screen.getByPlaceholderText('请编写本周工作总结...')).toBeDisabled();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument();
  });

  it('只有提交权限时直接提交已有草稿，不调用无权使用的保存接口', async () => {
    useAuthStore.setState((state) => ({
      ...state,
      user: state.user ? {
        ...state.user,
        permissions: ['weekly_report:view:self', 'weekly_report:submit:self'],
      } : null,
    }));
    vi.mocked(weeklyReportApi.getByWeek).mockResolvedValue({
      code: 0,
      data: { ...report, status: 'draft', content: '已有草稿内容' },
    });
    const user = userEvent.setup();
    render(<WeeklyReportPage />);

    expect(await screen.findByText('草稿')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /提交审批/ });
    expect(submit).not.toBeDisabled();
    await user.click(submit);
    await waitFor(() => expect(weeklyReportApi.submit).toHaveBeenCalledWith(9));
    expect(weeklyReportApi.save).not.toHaveBeenCalled();
    expect(timesheetApi.getWeeklySummary).not.toHaveBeenCalled();
    expect(screen.getByText('当前角色没有工时查看权限，无法展示工时汇总')).toBeInTheDocument();
  });

  it('空周报在前端阻止提交', async () => {
    vi.mocked(weeklyReportApi.getByWeek).mockResolvedValue({ code: 0, data: null });
    const user = userEvent.setup();
    render(<WeeklyReportPage />);

    await user.click(await screen.findByRole('button', { name: /提交审批/ }));
    expect(await screen.findByText('请填写周报内容后再提交')).toBeInTheDocument();
    expect(weeklyReportApi.save).not.toHaveBeenCalled();
    expect(weeklyReportApi.submit).not.toHaveBeenCalled();
  });
});
