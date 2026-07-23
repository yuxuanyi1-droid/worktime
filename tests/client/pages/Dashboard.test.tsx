import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from '@client/pages/Dashboard';
import { reportApi } from '@client/api/report';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/report', () => ({
  reportApi: { getDashboard: vi.fn() },
}));

vi.mock('@client/components/Charts/LazyEChart', () => ({
  default: () => <div data-testid="dashboard-chart" />,
}));

function setUser(permissions: string[]) {
  useAuthStore.setState({
    token: 'dashboard-token',
    user: {
      id: 1,
      username: 'dashboard-user',
      realName: '张三',
      department: null,
      group: null,
      roles: [],
      permissions,
    },
  });
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/timesheet" element={<div>工时页已打开</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('工作台页面', () => {
  beforeEach(() => {
    vi.mocked(reportApi.getDashboard).mockResolvedValue({
      code: 0,
      data: {
        monthDays: 9,
        overtimeDays: 2,
        pendingCount: 4,
        trend: [{ date: '2026-07-01', days: 1 }],
        hasTimesheetDrafts: true,
        weeklyReportStatus: 'draft',
      },
    } as any);
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('不在界面上泄露用户未获授权的工时、加班和审批汇总', async () => {
    setUser([]);
    renderDashboard();

    expect(await screen.findByText(/欢迎使用工时管理系统/)).toBeInTheDocument();
    expect(screen.queryByText('本月工时')).not.toBeInTheDocument();
    expect(screen.queryByText('本月加班')).not.toBeInTheDocument();
    expect(screen.queryByText('待审批')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /审批中心/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-chart')).not.toBeInTheDocument();
  });

  it('快捷操作使用键盘可达的按钮，并严格服从入口与操作权限', async () => {
    setUser([
      'timesheet:access', 'timesheet:view:self', 'timesheet:create', 'timesheet:submit:self',
      'approval:access', 'approval:view:todo',
    ]);
    const user = userEvent.setup();
    renderDashboard();

    const fillButton = await screen.findByRole('button', { name: /填报工时/ });
    expect(screen.getByRole('button', { name: /提交周工时/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /审批中心/ })).toBeInTheDocument();
    fillButton.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('工时页已打开')).toBeInTheDocument();
  });

  it('接口失败时显示服务端错误，而不是静默留白', async () => {
    setUser(['timesheet:view:self']);
    vi.mocked(reportApi.getDashboard).mockRejectedValue({
      response: { data: { message: '工作台服务暂不可用' } },
    });
    renderDashboard();
    expect(await screen.findByText('工作台服务暂不可用')).toBeInTheDocument();
  });

  it('没有草稿且本周周报已通过时不显示虚假提交待办', async () => {
    setUser([
      'timesheet:access', 'timesheet:view:self', 'timesheet:create', 'timesheet:submit:self',
      'weekly_report:access', 'weekly_report:view:self', 'weekly_report:create', 'weekly_report:submit:self',
    ]);
    vi.mocked(reportApi.getDashboard).mockResolvedValue({
      code: 0,
      data: {
        monthDays: 9, overtimeDays: 0, pendingCount: 0, trend: [],
        hasTimesheetDrafts: false, weeklyReportStatus: 'approved',
      },
    } as any);
    renderDashboard();

    expect(await screen.findByText('已通过')).toBeInTheDocument();
    expect(screen.queryByText('提交本周工时')).not.toBeInTheDocument();
    expect(screen.queryByText('提交本周周报')).not.toBeInTheDocument();
    expect(screen.getByText('暂无待办事项')).toBeInTheDocument();
  });

  it('本周周报状态卡可通过键盘进入周报页面', async () => {
    setUser(['weekly_report:access', 'weekly_report:view:self']);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/weekly-report" element={<div>周报页已打开</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const card = await screen.findByRole('button', { name: /本周周报/ });
    card.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('周报页已打开')).toBeInTheDocument();
  });

  it('错误提示提供重试并在恢复后展示数据', async () => {
    setUser(['timesheet:view:self']);
    vi.mocked(reportApi.getDashboard)
      .mockRejectedValueOnce({ response: { data: { message: '暂时失败' } } })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          monthDays: 3, overtimeDays: 0, pendingCount: 0, trend: [],
          hasTimesheetDrafts: false, weeklyReportStatus: null,
        },
      } as any);
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole('button', { name: /重\s*试/ }));
    expect(await screen.findByText('3天')).toBeInTheDocument();
    expect(screen.queryByText('暂时失败')).not.toBeInTheDocument();
  });
});
