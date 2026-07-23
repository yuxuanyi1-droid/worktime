import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import MainLayout from '@client/components/Layout/MainLayout';
import { notificationApi, announcementApi } from '@client/api/notification';
import { systemApi } from '@client/api/system';
import { authApi } from '@client/api/auth';
import { useAuthStore } from '@client/stores/authStore';
import { useAppStore } from '@client/stores/appStore';

vi.mock('@client/components/AgentChat', () => ({ default: () => null }));

vi.mock('@client/api/notification', async (importOriginal) => {
  const original = await importOriginal<typeof import('@client/api/notification')>();
  return {
    ...original,
    notificationApi: {
      getUnreadCount: vi.fn(),
      getList: vi.fn(),
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
    },
    announcementApi: {
      getMyUnreadCount: vi.fn(),
      getMyList: vi.fn(),
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
    },
  };
});

vi.mock('@client/api/system', () => ({
  systemApi: {
    getSettings: vi.fn(),
    canViewProjects: vi.fn(),
  },
}));

vi.mock('@client/api/auth', () => ({
  authApi: {
    getProfile: vi.fn(),
    logout: vi.fn(),
  },
}));

function setUser(permissions: string[], roles: { id: number; name: string; label: string }[] = []) {
  const user = {
    id: 1,
    username: 'layout-user',
    realName: '布局用户',
    department: null,
    group: null,
    roles,
    permissions,
  };
  useAuthStore.setState({ token: 'layout-token', user });
  vi.mocked(authApi.getProfile).mockResolvedValue({ code: 0, data: user } as any);
}

function LoginProbe() {
  const location = useLocation();
  return <div>登录页 {location.search}</div>;
}

function renderLayout(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route path="/" element={<MainLayout />}>
          <Route index element={<div>工作台内容</div>} />
          <Route path="report" element={<div>报表内容</div>} />
          <Route path="approval/detail/:targetType/:targetId" element={<div>审批详情已打开</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('主布局', () => {
  beforeEach(() => {
    useAppStore.setState({ systemName: 'WorkTime', settingsLoaded: false });
    vi.mocked(systemApi.getSettings).mockResolvedValue({ code: 0, data: { settings: {} } } as any);
    vi.mocked(systemApi.canViewProjects).mockResolvedValue({
      code: 0, data: { canView: false, isAdmin: false, isManager: false },
    });
    vi.mocked(notificationApi.getUnreadCount).mockResolvedValue({ code: 0, data: { count: 0 } });
    vi.mocked(announcementApi.getMyUnreadCount).mockResolvedValue({ code: 0, data: { count: 0 } });
    vi.mocked(notificationApi.getList).mockResolvedValue({
      code: 0, data: { list: [], total: 0, page: 1, pageSize: 10 },
    });
    vi.mocked(announcementApi.getMyList).mockResolvedValue({
      code: 0, data: { list: [], total: 0, page: 1, pageSize: 10 },
    });
    vi.mocked(notificationApi.markAsRead).mockResolvedValue({ code: 0 });
  });

  afterEach(() => {
    useAuthStore.setState({ token: null, user: null });
    vi.clearAllMocks();
  });

  it('菜单同时服从入口权限和项目范围二次校验', async () => {
    setUser(['timesheet:access', 'project:access']);
    renderLayout();

    expect(await screen.findByRole('link', { name: /工时/ })).toBeInTheDocument();
    await waitFor(() => expect(systemApi.canViewProjects).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /项目/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /管理/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开用户菜单' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  });

  it('通知只对安全白名单内的审批类型进行详情跳转', async () => {
    setUser([]);
    vi.mocked(notificationApi.getUnreadCount).mockResolvedValue({ code: 0, data: { count: 1 } });
    vi.mocked(notificationApi.getList).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 7, userId: 1, type: 'approval_pending', title: '工时待审批', content: null,
          targetType: 'timesheet', targetId: 9, isRead: false, createdAt: '2026-07-22T00:00:00Z',
        }],
        total: 1, page: 1, pageSize: 10,
      },
    });
    const user = userEvent.setup();
    renderLayout();

    await user.click(await screen.findByRole('button', { name: /通知，1 条未读/ }));
    await user.click(await screen.findByRole('button', { name: '工时待审批' }));
    expect(await screen.findByText('审批详情已打开')).toBeInTheDocument();
    expect(notificationApi.markAsRead).toHaveBeenCalledWith([7]);
  });

  it('收到 401 事件时软跳转登录页并保留完整返回地址', async () => {
    setUser(['report:access']);
    renderLayout('/report?range=month');
    expect(await screen.findByText('报表内容')).toBeInTheDocument();
    window.dispatchEvent(new CustomEvent('unauthorized'));
    expect(await screen.findByText(/redirect=%2Freport%3Frange%3Dmonth/)).toBeInTheDocument();
  });
});
