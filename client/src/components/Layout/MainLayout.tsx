import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Alert, Dropdown, Badge, Popover, List, Empty, Spin, Tag, Tabs, Space, Button, message } from 'antd';
import { ErrorBoundary } from '../ErrorBoundary';
import AgentChat from '../AgentChat';
import {
  DashboardOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  KeyOutlined,
  BellOutlined,
  DeleteOutlined,
  CheckOutlined,
  NotificationOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  ExclamationCircleOutlined,
  ProjectOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../../stores/authStore';
import { usePermission } from '../../hooks/usePermission';
import { useAppStore } from '../../stores/appStore';
import {
  announcementApi,
  AnnouncementItem,
  emitNotificationReadStateChanged,
  notificationApi,
  NotificationItem,
  NOTIFICATION_READ_STATE_EVENT,
} from '../../api/notification';
import { systemApi } from '../../api/system';
import { authApi } from '../../api/auth';
import { useEffect, useState, useRef, useCallback } from 'react';

interface MenuItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  permission?: string;
}

export const allMenuItems: MenuItem[] = [
  { key: '/permission-request', icon: <KeyOutlined />, label: '权限申请', permission: 'permission_request:access' },
  { key: '/', icon: <DashboardOutlined />, label: '工作台' },
  { key: '/timesheet', icon: <ClockCircleOutlined />, label: '工时', permission: 'timesheet:access' },
  { key: '/overtime', icon: <ThunderboltOutlined />, label: '加班', permission: 'overtime:access' },
  { key: '/weekly-report', icon: <FileTextOutlined />, label: '周报', permission: 'weekly_report:access' },
  { key: '/approval', icon: <CheckCircleOutlined />, label: '审批', permission: 'approval:access' },
  { key: '/report', icon: <BarChartOutlined />, label: '报表', permission: 'report:access' },
  { key: '/project', icon: <ProjectOutlined />, label: '项目', permission: 'project:access' },
  { key: '/system', icon: <SettingOutlined />, label: '管理', permission: 'system:access' },
];

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, clearAuth, setAuth, token } = useAuthStore();
  const { hasPermission, isAdmin } = usePermission();
  const hasProjectAccess = hasPermission('project:access');
  const { systemName, loadSettings } = useAppStore();

  const [canViewProject, setCanViewProject] = useState(false);
  const [projectPermissionLoading, setProjectPermissionLoading] = useState(true);
  const [notifUnread, setNotifUnread] = useState(0);
  const [announUnread, setAnnounUnread] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [notifTab, setNotifTab] = useState('notif');
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const totalUnread = notifUnread + announUnread;

  const loadUnreadCounts = useCallback(async () => {
    try {
      const [nRes, aRes] = await Promise.all([
        notificationApi.getUnreadCount(),
        announcementApi.getMyUnreadCount(),
      ]);
      if (nRes.data) setNotifUnread(nRes.data.count);
      if (aRes.data) setAnnounUnread(aRes.data.count);
    } catch {}
  }, []);

  const loadNotifications = useCallback(async () => {
    setNotifLoading(true);
    setNotifError(null);
    try {
      const [nRes, aRes] = await Promise.all([
        notificationApi.getList({ pageSize: 10, isRead: false }),
        announcementApi.getMyList({ pageSize: 10, isRead: false }),
      ]);
      if (nRes.data) setNotifications(nRes.data.list);
      if (aRes.data) setAnnouncements(aRes.data.list);
    } catch (error: any) {
      setNotifError(error?.response?.data?.message || error?.message || '通知加载失败');
    } finally {
      setNotifLoading(false);
    }
  }, []);

  const handleNotifClick = async (item: NotificationItem) => {
    if (!item.isRead) {
      try {
        await notificationApi.markAsRead([item.id]);
        setNotifications(current => current.filter(notification => notification.id !== item.id));
        setNotifUnread(current => Math.max(0, current - 1));
        emitNotificationReadStateChanged();
      } catch (error: any) {
        message.error(error?.response?.data?.message || error?.message || '标记通知已读失败');
      }
    }
    const approvalTypes = ['timesheet', 'overtime', 'weekly_report', 'permission_request'];
    if (item.targetType && item.targetId && approvalTypes.includes(item.targetType)) {
      navigate(`/approval/detail/${item.targetType}/${item.targetId}`);
      setPopoverOpen(false);
    }
  };

  const handleAnnounClick = async (item: AnnouncementItem) => {
    if (!item.isRead) {
      try {
        await announcementApi.markAsRead(item.id);
        setAnnouncements(current => current.filter(announcement => announcement.id !== item.id));
        setAnnounUnread(current => Math.max(0, current - 1));
        emitNotificationReadStateChanged();
      } catch (error: any) {
        message.error(error?.response?.data?.message || error?.message || '标记公告已读失败');
      }
    }
  };

  const handleMarkAllRead = async () => {
    try {
      if (notifTab === 'notif') await notificationApi.markAllAsRead();
      else await announcementApi.markAllAsRead();
      if (notifTab === 'notif') {
        setNotifications([]);
        setNotifUnread(0);
      } else {
        setAnnouncements([]);
        setAnnounUnread(0);
      }
      emitNotificationReadStateChanged();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '全部已读失败');
    }
  };

  const handleViewAll = () => {
    navigate(`/notifications?tab=${notifTab}`);
    setPopoverOpen(false);
  };

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // 每次应用挂载时刷新用户档案，确保角色权限修改和权限推导规则立即反映到菜单。
  useEffect(() => {
    if (!token) return;
    authApi.getProfile()
      .then((res) => { if (res.data) setAuth(token, res.data); })
      .catch(() => { /* 401 由请求拦截器统一处理 */ });
  }, [setAuth, token]);

  // 检查用户是否可以查看项目管理（管理员或被指定为项目管理员）
  useEffect(() => {
    if (!hasProjectAccess) {
      setCanViewProject(false);
      setProjectPermissionLoading(false);
    } else if (isAdmin) {
      setCanViewProject(true);
      setProjectPermissionLoading(false);
    } else {
      systemApi.canViewProjects().then(res => {
        if (res.data?.canView) setCanViewProject(true);
      }).catch(() => {}).finally(() => setProjectPermissionLoading(false));
    }
  }, [hasProjectAccess, isAdmin]);

  useEffect(() => {
    loadUnreadCounts();
    pollRef.current = setInterval(loadUnreadCounts, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadUnreadCounts]);

  useEffect(() => {
    window.addEventListener(NOTIFICATION_READ_STATE_EVENT, loadUnreadCounts);
    return () => window.removeEventListener(NOTIFICATION_READ_STATE_EVENT, loadUnreadCounts);
  }, [loadUnreadCounts]);

  useEffect(() => {
    if (popoverOpen) loadNotifications();
  }, [popoverOpen, loadNotifications]);

  const typeIcon = (type: string) => {
    if (type === 'approval_pending') return <CheckCircleOutlined style={{ color: '#6B8F71' }} />;
    if (type === 'approval_approved') return <CheckCircleOutlined style={{ color: '#4A8B5E' }} />;
    if (type === 'approval_rejected') return <DeleteOutlined style={{ color: '#C0564B' }} />;
    if (type === 'approval_cc') return <SendOutlined style={{ color: '#722ed1' }} />;
    return <BellOutlined />;
  };

  const announTypeIcon = (type: string) => {
    if (type === 'urgent') return <ExclamationCircleOutlined style={{ color: '#C0564B' }} />;
    if (type === 'important') return <WarningOutlined style={{ color: '#C89B50' }} />;
    return <InfoCircleOutlined style={{ color: '#6B8F71' }} />;
  };

  const announTypeTag = (type: string) => {
    if (type === 'urgent') return <Tag color="error" style={{ fontSize: 11, marginRight: 4 }}>紧急</Tag>;
    if (type === 'important') return <Tag color="warning" style={{ fontSize: 11, marginRight: 4 }}>重要</Tag>;
    return null;
  };

  const currentTabUnread = notifTab === 'notif' ? notifUnread : announUnread;

  const notifContent = (
    <div style={{ width: 380, maxHeight: 520 }}>
      <Tabs
        activeKey={notifTab}
        onChange={setNotifTab}
        size="small"
        items={[
          {
            key: 'notif',
            label: (
              <span>
                <BellOutlined style={{ marginRight: 4 }} />
                通知
                {notifUnread > 0 && <Badge count={notifUnread} size="small" style={{ marginLeft: 6 }} />}
              </span>
            ),
          },
          {
            key: 'announce',
            label: (
              <span>
                <NotificationOutlined style={{ marginRight: 4 }} />
                公告
                {announUnread > 0 && <Badge count={announUnread} size="small" style={{ marginLeft: 6 }} />}
              </span>
            ),
          },
        ]}
        tabBarExtraContent={
          <Space>
            <Button size="small" type="link" onClick={handleViewAll}>
              查看全部记录
            </Button>
            {currentTabUnread > 0 && (
              <Button size="small" type="link" onClick={handleMarkAllRead}>全部已读</Button>
            )}
          </Space>
        }
      />
      {notifError && (
        <Alert
          type="error"
          showIcon
          message={notifError}
          action={<Button size="small" onClick={loadNotifications}>重试</Button>}
          style={{ marginBottom: 8 }}
        />
      )}
      <Spin spinning={notifLoading}>
        {notifTab === 'notif' ? (
          notifications.length === 0 ? (
            <Empty description="暂无未读通知" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={notifications}
              style={{ maxHeight: 400, overflow: 'auto' }}
              renderItem={(item) => (
                <List.Item
                  style={{
                    background: item.isRead ? 'transparent' : '#F0EDE6',
                    padding: '8px 12px',
                    borderRadius: 10,
                    marginBottom: 4,
                  }}
                >
                  <List.Item.Meta
                    avatar={typeIcon(item.type)}
                    title={(
                      <Button
                        type="text"
                        size="small"
                        style={{ height: 'auto', padding: 0, fontSize: 13, fontWeight: item.isRead ? 400 : 600, textAlign: 'left' }}
                        onClick={() => handleNotifClick(item)}
                      >
                        {item.title}
                      </Button>
                    )}
                    description={
                      <span style={{ fontSize: 12, color: '#9A9080' }}>
                        {item.content && <span>{item.content}<br /></span>}
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          )
        ) : (
          announcements.length === 0 ? (
            <Empty description="暂无未读公告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={announcements}
              style={{ maxHeight: 400, overflow: 'auto' }}
              renderItem={(item) => (
                <List.Item
                  style={{
                    background: item.isRead ? 'transparent' : '#F5F0E6',
                    padding: '8px 12px',
                    borderRadius: 10,
                    marginBottom: 4,
                    borderLeft: item.isRead ? 'none' : (item.type === 'urgent' ? '3px solid #C0564B' : item.type === 'important' ? '3px solid #C89B50' : '3px solid #6B8F71'),
                  }}
                  actions={item.isRead ? undefined : [
                    <Button key="read" size="small" type="primary" ghost
                      onClick={(e) => { e.stopPropagation(); handleAnnounClick(item); }}>
                      我知道了
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={announTypeIcon(item.type)}
                    title={
                      <Button
                        type="text"
                        size="small"
                        style={{ height: 'auto', padding: 0, fontSize: 13, fontWeight: item.isRead ? 400 : 600, textAlign: 'left' }}
                        onClick={() => handleAnnounClick(item)}
                      >
                        {announTypeTag(item.type)}
                        {item.title}
                      </Button>
                    }
                    description={
                      <span style={{ fontSize: 12, color: '#9A9080' }}>
                        {item.content && item.content.length > 60 ? item.content.substring(0, 60) + '...' : item.content}
                        <br />
                        {item.createdByName && <span>{item.createdByName} · </span>}
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          )
        )}
      </Spin>
    </div>
  );

  const menuItems = allMenuItems.filter((item) => {
    if (item.permission && !hasPermission(item.permission)) return false;
    if (item.key === '/project' && (!canViewProject || projectPermissionLoading)) return false;
    return true;
  });

  const handleLogout = async () => {
    // 调用后端 logout 使 token 失效（tokenVersion+1）；失败不阻塞退出
    try { await authApi.logout(); } catch {}
    clearAuth();
    navigate('/login');
  };

  const userMenuItems = [
    { key: 'profile', icon: <UserOutlined />, label: '个人信息' },
    { key: 'pat', icon: <KeyOutlined />, label: '访问令牌' },
    { key: 'divider', type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ];

  const handleUserMenu = ({ key }: { key: string }) => {
    if (key === 'logout') handleLogout();
    else if (key === 'profile') navigate('/profile');
    else if (key === 'pat') navigate('/pat');
  };

  const currentPath = location.pathname;

  // 注：路由级权限由 router/index.tsx 的 PermissionRoute 负责（显示 403 页面），
  // 不再在此处做 isKnownRoute/isAllowed 重定向（避免与 PermissionRoute 职责重叠导致 UX 抖动）。

  // 监听 401 事件，软跳转到登录页（保留 SPA 状态，带 redirect 以便登录后返回）
  useEffect(() => {
    const onUnauthorized = () => {
      const redirect = encodeURIComponent(location.pathname + location.search);
      navigate(`/login?redirect=${redirect}`, { replace: true });
    };
    window.addEventListener('unauthorized', onUnauthorized);
    return () => window.removeEventListener('unauthorized', onUnauthorized);
  }, [location.pathname, location.search, navigate]);

  const isActive = (key: string) => {
    if (key === '/') return currentPath === '/';
    return currentPath === key || currentPath.startsWith(key + '/');
  };

  return (
    <div style={{ minHeight: '100vh', background: '#F8F4ED' }}>
      {/* 顶部导航 */}
      <div style={{
        padding: '14px clamp(16px, 4vw, 40px)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        background: '#F8F4ED',
        borderBottom: '1px solid #E8E0D4',
      }}>
        {/* 品牌 */}
        <Link to="/" style={{
          fontFamily: '"Fraunces", Georgia, serif',
          fontSize: 20,
          fontWeight: 700,
          color: '#2C2418',
          letterSpacing: '-0.01em',
          textDecoration: 'none',
        }}>
          {systemName}
        </Link>

        {/* 胶囊导航 */}
        <nav aria-label="主导航" style={{ display: 'flex', gap: 4, overflowX: 'auto', maxWidth: '100%', paddingBottom: 2 }}>
          {menuItems.map((item) => (
            <Link
              key={item.key}
              to={item.key}
              aria-current={isActive(item.key) ? 'page' : undefined}
              style={{
                padding: '8px 18px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: isActive(item.key) ? 600 : 500,
                color: isActive(item.key) ? '#FDFBF7' : '#5A5040',
                background: isActive(item.key) ? '#2C2418' : 'transparent',
                textDecoration: 'none',
                transition: 'background-color 0.2s ease, color 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                if (!isActive(item.key)) e.currentTarget.style.background = '#EDE8DE';
              }}
              onMouseLeave={(e) => {
                if (!isActive(item.key)) e.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={{ fontSize: 14 }}>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        {/* 右侧操作 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Popover
            content={notifContent}
            trigger="click"
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
            placement="bottomRight"
          >
            <button type="button" aria-label={`通知，${totalUnread} 条未读`} style={{
              width: 36, height: 36, borderRadius: '50%',
              background: '#EDE8DE',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', transition: 'background 0.2s',
              position: 'relative',
              border: 0,
              padding: 0,
            }}>
              <BellOutlined style={{ fontSize: 16, color: '#5A5040' }} />
              {totalUnread > 0 && (
                <div style={{
                  position: 'absolute', top: 2, right: 2,
                  width: 16, height: 16, borderRadius: '50%',
                  background: '#C0564B', color: '#fff',
                  fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{totalUnread > 99 ? '99+' : totalUnread}</div>
              )}
            </button>
          </Popover>
          <Dropdown menu={{ items: userMenuItems, onClick: handleUserMenu }} placement="bottomRight">
            <button type="button" aria-label="打开用户菜单" style={{
              width: 36, height: 36, borderRadius: '50%',
              background: '#C4956A',
              color: '#FDFBF7',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 600,
              cursor: 'pointer',
              border: 0,
              padding: 0,
            }}>
              {user?.realName?.[0] || user?.username?.[0] || '?'}
            </button>
          </Dropdown>
        </div>
      </div>

      {/* 内容区 */}
      <div style={{
        padding: '28px clamp(16px, 4vw, 40px)',
        minHeight: 'calc(100vh - 65px)',
      }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </div>

      {/* 全局悬浮 AI 助手 */}
      <AgentChat />
    </div>
  );
}
