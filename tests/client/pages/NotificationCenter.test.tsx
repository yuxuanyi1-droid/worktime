import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import NotificationCenter from '@client/pages/NotificationCenter';
import {
  announcementApi,
  emitNotificationReadStateChanged,
  notificationApi,
} from '@client/api/notification';

vi.mock('@client/api/notification', () => ({
  NOTIFICATION_READ_STATE_EVENT: 'notification-read-state-changed',
  emitNotificationReadStateChanged: vi.fn(),
  notificationApi: {
    getList: vi.fn(),
    getUnreadCount: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    delete: vi.fn(),
  },
  announcementApi: {
    getMyList: vi.fn(),
    getMyUnreadCount: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
  },
}));

const unreadNotification = {
  id: 8,
  userId: 1,
  type: 'approval_cc',
  title: '审批抄送：周报申请',
  content: '张三向您抄送了一份周报申请',
  targetType: 'weekly_report',
  targetId: 21,
  isRead: false,
  createdAt: '2026-07-22T08:00:00.000Z',
};

const unreadAnnouncement = {
  id: 15,
  title: '系统维护通知',
  content: '今晚进行系统维护',
  type: 'important' as const,
  targetScope: 'all' as const,
  targetDeptId: null,
  targetGroupId: null,
  targetUserIds: null,
  createdById: 2,
  createdByName: '管理员',
  isRead: false,
  createdAt: '2026-07-22T08:00:00.000Z',
};

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <LocationProbe />
      <Routes>
        <Route path="/notifications" element={<NotificationCenter />} />
        <Route path="/approval/detail/:targetType/:targetId" element={<div>审批详情占位</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('通知中心页面', () => {
  beforeEach(() => {
    vi.mocked(notificationApi.getList).mockResolvedValue({
      code: 0,
      data: { list: [unreadNotification], total: 1, page: 1, pageSize: 20 },
    });
    vi.mocked(announcementApi.getMyList).mockResolvedValue({
      code: 0,
      data: { list: [], total: 0, page: 1, pageSize: 20 },
    });
    vi.mocked(notificationApi.markAsRead).mockResolvedValue({ code: 0 });
    vi.mocked(notificationApi.markAllAsRead).mockResolvedValue({ code: 0 });
    vi.mocked(notificationApi.delete).mockResolvedValue({ code: 0 });
    vi.mocked(announcementApi.markAsRead).mockResolvedValue({ code: 0 });
    vi.mocked(announcementApi.markAllAsRead).mockResolvedValue({ code: 0 });
  });

  it('“标为已读”只更新状态，不意外打开审批详情', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '标为已读' }));

    await waitFor(() => expect(notificationApi.markAsRead).toHaveBeenCalledWith([8]));
    expect(screen.getByTestId('location')).toHaveTextContent('/notifications');
    expect(await screen.findByText('已读')).toBeInTheDocument();
    expect(emitNotificationReadStateChanged).toHaveBeenCalled();
  });

  it('点击通知标题会标为已读并打开对应审批详情', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '审批抄送：周报申请' }));

    await waitFor(() => expect(notificationApi.markAsRead).toHaveBeenCalledWith([8]));
    expect(await screen.findByText('审批详情占位')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/approval/detail/weekly_report/21');
  });

  it('通知列表使用服务端分页', async () => {
    vi.mocked(notificationApi.getList)
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 45, page: 1, pageSize: 20 } })
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 45, page: 2, pageSize: 20 } });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(notificationApi.getList).toHaveBeenCalledWith({ page: 1, pageSize: 20 }));
    await user.click(await screen.findByTitle('2'));
    await waitFor(() => expect(notificationApi.getList).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 }));
  });

  it('首次只加载当前页签，切换后才请求系统公告', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(notificationApi.getList).toHaveBeenCalledOnce());
    expect(announcementApi.getMyList).not.toHaveBeenCalled();
    await user.click(screen.getByRole('tab', { name: /系统公告/ }));
    await waitFor(() => expect(announcementApi.getMyList).toHaveBeenCalledWith({ page: 1, pageSize: 20 }));
  });

  it('打开未读公告后即时更新本地状态和全局未读数', async () => {
    vi.mocked(announcementApi.getMyList).mockResolvedValue({
      code: 0,
      data: { list: [unreadAnnouncement], total: 1, page: 1, pageSize: 20 },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('tab', { name: /系统公告/ }));
    await user.click(await screen.findByRole('button', { name: '系统维护通知' }));

    await waitFor(() => expect(announcementApi.markAsRead).toHaveBeenCalledWith(15));
    expect(screen.getAllByText('今晚进行系统维护')).toHaveLength(2);
    expect(screen.getByText('已读')).toBeInTheDocument();
    expect(emitNotificationReadStateChanged).toHaveBeenCalled();
    expect(announcementApi.getMyList).toHaveBeenCalledOnce();
  });

  it('全部已读即时更新当前通知列表且防止重复提交', async () => {
    let resolveMarkAll!: () => void;
    vi.mocked(notificationApi.markAllAsRead).mockImplementation(() => new Promise((resolve) => {
      resolveMarkAll = () => resolve({ code: 0 });
    }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: '标为已读' });
    const markAll = screen.getByRole('button', { name: /全部标为已读/ });
    await user.click(markAll);
    expect(markAll).toHaveClass('ant-btn-loading');
    await user.click(markAll);
    expect(notificationApi.markAllAsRead).toHaveBeenCalledOnce();
    resolveMarkAll();

    await waitFor(() => expect(screen.queryByRole('button', { name: '标为已读' })).not.toBeInTheDocument());
    expect(emitNotificationReadStateChanged).toHaveBeenCalled();
  });

  it('通知加载失败时清空旧状态并提供重试入口', async () => {
    vi.mocked(notificationApi.getList)
      .mockRejectedValueOnce({ response: { data: { message: '通知服务暂不可用' } } })
      .mockResolvedValueOnce({
        code: 0,
        data: { list: [unreadNotification], total: 1, page: 1, pageSize: 20 },
      });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('通知服务暂不可用')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(await screen.findByRole('button', { name: '审批抄送：周报申请' })).toBeInTheDocument();
    expect(notificationApi.getList).toHaveBeenCalledTimes(2);
  });

  it('删除通知后移除当前行并同步总未读状态', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除' }));
    const confirm = document.querySelector('.ant-popconfirm-buttons .ant-btn-primary');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);

    await waitFor(() => expect(notificationApi.delete).toHaveBeenCalledWith(8));
    expect(screen.queryByRole('button', { name: '审批抄送：周报申请' })).not.toBeInTheDocument();
    expect(emitNotificationReadStateChanged).toHaveBeenCalled();
  });
});
