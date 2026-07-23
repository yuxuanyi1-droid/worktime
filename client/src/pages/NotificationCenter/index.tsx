import { useEffect, useRef, useState } from 'react';
import {
  Alert, Card, Tabs, Table, Button, Space, Tag, Typography, Empty, Modal, message,
  List, Spin, Descriptions, Popconfirm,
} from 'antd';
import {
  BellOutlined, NotificationOutlined, CheckCircleOutlined, DeleteOutlined,
  InfoCircleOutlined, WarningOutlined, ExclamationCircleOutlined, SendOutlined,
} from '@ant-design/icons';
import {
  announcementApi,
  AnnouncementItem,
  emitNotificationReadStateChanged,
  notificationApi,
  NotificationItem,
} from '../../api/notification';
import { useNavigate, useSearchParams } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;

export default function NotificationCenter() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [tabKey, setTabKey] = useState(requestedTab === 'announce' ? 'announce' : 'notif');
  const [notifLoading, setNotifLoading] = useState(false);
  const [announLoading, setAnnounLoading] = useState(false);
  const [markAllLoading, setMarkAllLoading] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [announError, setAnnounError] = useState<string | null>(null);
  const notifRequestId = useRef(0);
  const announRequestId = useRef(0);

  // 通知
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notifTotal, setNotifTotal] = useState(0);
  const [notifPage, setNotifPage] = useState(1);

  // 公告
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [announTotal, setAnnounTotal] = useState(0);
  const [announPage, setAnnounPage] = useState(1);

  // 公告详情
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<AnnouncementItem | null>(null);

  const loadNotifications = async () => {
    const requestId = ++notifRequestId.current;
    setNotifLoading(true);
    setNotifError(null);
    try {
      const res = await notificationApi.getList({ page: notifPage, pageSize: 20 });
      if (requestId === notifRequestId.current && res.data) {
        setNotifications(res.data.list);
        setNotifTotal(res.data.total);
      }
    } catch (e: any) {
      if (requestId === notifRequestId.current) {
        setNotifications([]);
        setNotifTotal(0);
        setNotifError(e?.response?.data?.message || '通知加载失败');
      }
    } finally {
      if (requestId === notifRequestId.current) setNotifLoading(false);
    }
  };

  const loadAnnouncements = async () => {
    const requestId = ++announRequestId.current;
    setAnnounLoading(true);
    setAnnounError(null);
    try {
      const res = await announcementApi.getMyList({ page: announPage, pageSize: 20 });
      if (requestId === announRequestId.current && res.data) {
        setAnnouncements(res.data.list);
        setAnnounTotal(res.data.total);
      }
    } catch (e: any) {
      if (requestId === announRequestId.current) {
        setAnnouncements([]);
        setAnnounTotal(0);
        setAnnounError(e?.response?.data?.message || '公告加载失败');
      }
    } finally {
      if (requestId === announRequestId.current) setAnnounLoading(false);
    }
  };

  useEffect(() => {
    if (tabKey === 'notif') void loadNotifications();
  }, [tabKey, notifPage]);
  useEffect(() => {
    if (tabKey === 'announce') void loadAnnouncements();
  }, [tabKey, announPage]);
  useEffect(() => {
    setTabKey(requestedTab === 'announce' ? 'announce' : 'notif');
  }, [requestedTab]);

  const handleTabChange = (key: string) => {
    setTabKey(key);
    setSearchParams({ tab: key }, { replace: true });
  };

  const markNotificationAsRead = async (item: NotificationItem) => {
    if (item.isRead) return true;
    try {
      await notificationApi.markAsRead([item.id]);
      setNotifications(current => current.map(notification => (
        notification.id === item.id ? { ...notification, isRead: true } : notification
      )));
      emitNotificationReadStateChanged();
      return true;
    } catch {
      return false;
    }
  };

  const handleNotifOpen = async (item: NotificationItem) => {
    await markNotificationAsRead(item);
    // 只有审批类通知才跳转详情页，其它类型（如 system）不跳
    const approvalTypes = ['timesheet', 'overtime', 'weekly_report', 'permission_request'];
    if (item.targetType && item.targetId && approvalTypes.includes(item.targetType)) {
      navigate(`/approval/detail/${item.targetType}/${item.targetId}`);
    }
  };

  const handleNotifMarkRead = async (item: NotificationItem) => {
    await markNotificationAsRead(item);
  };

  const handleNotifDelete = async (item: NotificationItem) => {
    try {
      await notificationApi.delete(item.id);
      setNotifTotal(current => Math.max(0, current - 1));
      if (notifications.length === 1 && notifPage > 1) {
        setNotifPage(current => current - 1);
      } else {
        setNotifications(current => current.filter(notification => notification.id !== item.id));
      }
      emitNotificationReadStateChanged();
      message.success('通知已删除');
    } catch {
      // 请求拦截器负责展示服务端错误。
    }
  };

  const handleAnnounClick = async (item: AnnouncementItem) => {
    let detail = item;
    if (!item.isRead) {
      try {
        await announcementApi.markAsRead(item.id);
        emitNotificationReadStateChanged();
        setAnnouncements(current => current.map(announcement => (
          announcement.id === item.id ? { ...announcement, isRead: true } : announcement
        )));
        detail = { ...item, isRead: true };
      } catch {}
    }
    setDetailItem(detail);
    setDetailOpen(true);
  };

  const handleMarkAllReadNotif = async () => {
    setMarkAllLoading(true);
    try {
      await notificationApi.markAllAsRead();
      emitNotificationReadStateChanged();
      setNotifications(current => current.map(notification => ({ ...notification, isRead: true })));
    } catch {
      // 拦截器已弹 message.error
    } finally {
      setMarkAllLoading(false);
    }
  };

  const handleMarkAllReadAnnoun = async () => {
    setMarkAllLoading(true);
    try {
      await announcementApi.markAllAsRead();
      emitNotificationReadStateChanged();
      setAnnouncements(current => current.map(announcement => ({ ...announcement, isRead: true })));
    } catch {
      // 拦截器已弹 message.error
    } finally {
      setMarkAllLoading(false);
    }
  };

  const typeIcon = (type: string) => {
    if (type === 'approval_pending') return <CheckCircleOutlined style={{ color: '#6B8F71' }} />;
    if (type === 'approval_approved') return <CheckCircleOutlined style={{ color: '#4A8B5E' }} />;
    if (type === 'approval_rejected') return <DeleteOutlined style={{ color: '#C0564B' }} />;
    if (type === 'approval_cc') return <SendOutlined style={{ color: '#722ed1' }} />;
    return <BellOutlined />;
  };

  const typeLabel: Record<string, string> = {
    approval_pending: '待审批', approval_approved: '已通过', approval_rejected: '已驳回',
    approval_cc: '审批抄送', system: '系统',
  };

  const announTypeIcon = (type: string) => {
    if (type === 'urgent') return <ExclamationCircleOutlined style={{ color: '#C0564B', fontSize: 20 }} />;
    if (type === 'important') return <WarningOutlined style={{ color: '#faad14', fontSize: 20 }} />;
    return <InfoCircleOutlined style={{ color: '#6B8F71', fontSize: 20 }} />;
  };

  const announTypeTag = (type: string) => {
    if (type === 'urgent') return <Tag color="red">紧急</Tag>;
    if (type === 'important') return <Tag color="orange">重要</Tag>;
    return <Tag color="blue">通知</Tag>;
  };

  const notifColumns = [
    {
      title: '状态', width: 60, render: (_: any, r: NotificationItem) =>
        r.isRead ? <Tag>已读</Tag> : <Tag color="blue">未读</Tag>,
    },
    {
      title: '类型', dataIndex: 'type', width: 90,
      render: (t: string) => <Tag>{typeLabel[t] || t}</Tag>,
    },
    {
      title: '标题', dataIndex: 'title', ellipsis: true,
      render: (t: string, r: NotificationItem) => (
        <Button
          type="link"
          style={{ height: 'auto', padding: 0, fontWeight: r.isRead ? 400 : 600, textAlign: 'left' }}
          onClick={() => handleNotifOpen(r)}
        >
          {t}
        </Button>
      ),
    },
    {
      title: '内容', dataIndex: 'content', width: 250, ellipsis: true,
      render: (t: string) => t || '-',
    },
    {
      title: '时间', dataIndex: 'createdAt', width: 160,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作', width: 120,
      render: (_: any, r: NotificationItem) => (
        <Space>
          {!r.isRead && (
            <Button type="link" size="small" onClick={() => handleNotifMarkRead(r)}>标为已读</Button>
          )}
          <Popconfirm title="确定删除这条通知？" onConfirm={() => handleNotifDelete(r)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>通知中心</Title>
      <Card style={{ borderRadius: 12 }}>
        <Tabs activeKey={tabKey} onChange={handleTabChange} items={[
          {
            key: 'notif',
            label: (
              <span><BellOutlined style={{ marginRight: 4 }} />审批通知</span>
            ),
          },
          {
            key: 'announce',
            label: (
              <span><NotificationOutlined style={{ marginRight: 4 }} />系统公告</span>
            ),
          },
        ]} tabBarExtraContent={
          <Button
            type="link"
            loading={markAllLoading}
            disabled={tabKey === 'notif' ? notifLoading : announLoading}
            onClick={tabKey === 'notif' ? handleMarkAllReadNotif : handleMarkAllReadAnnoun}
          >
            全部标为已读
          </Button>
        }
        />

        {tabKey === 'notif' ? (
          notifError ? (
            <Alert
              type="warning"
              showIcon
              message={notifError}
              action={<Button size="small" onClick={() => void loadNotifications()}>重试</Button>}
            />
          ) : (
            <Table rowKey="id" columns={notifColumns} dataSource={notifications}
              loading={notifLoading}
              pagination={{
                current: notifPage, total: notifTotal, pageSize: 20,
                showSizeChanger: false,
                onChange: setNotifPage, showTotal: (t) => `共 ${t} 条`,
              }}
              size="middle" />
          )
        ) : (
          <Spin spinning={announLoading}>
            {announError ? (
              <Alert
                type="warning"
                showIcon
                message={announError}
                action={<Button size="small" onClick={() => void loadAnnouncements()}>重试</Button>}
              />
            ) : announcements.length === 0 ? (
              <Empty description="暂无系统公告" />
            ) : (
              <List
                dataSource={announcements}
                pagination={{
                  current: announPage, total: announTotal, pageSize: 20,
                  showSizeChanger: false,
                  onChange: setAnnounPage, showTotal: (t) => `共 ${t} 条`,
                }}
                renderItem={(item) => (
                  <List.Item
                    style={{
                      padding: '16px 20px',
                      marginBottom: 8,
                      borderRadius: 8,
                      background: item.isRead ? '#fafafa' : '#fff',
                      borderLeft: item.isRead ? 'none' : (
                        item.type === 'urgent' ? '4px solid #C0564B' :
                        item.type === 'important' ? '4px solid #faad14' : '4px solid #6B8F71'
                      ),
                      boxShadow: item.isRead ? 'none' : '0 1px 4px rgba(0,0,0,0.06)',
                    }}
                    actions={[
                      item.isRead ? (
                        <Tag key="read">已读</Tag>
                      ) : (
                        <Button key="ack" type="primary" size="small"
                          onClick={(e) => { e.stopPropagation(); handleAnnounClick(item); }}>
                          我知道了
                        </Button>
                      ),
                    ]}
                  >
                    <List.Item.Meta
                      avatar={announTypeIcon(item.type)}
                      title={
                        <span style={{ display: 'flex', alignItems: 'center' }}>
                          {announTypeTag(item.type)}
                          <Button
                            type="link"
                            style={{ height: 'auto', padding: '0 4px', fontWeight: item.isRead ? 400 : 600, textAlign: 'left' }}
                            onClick={() => handleAnnounClick(item)}
                          >
                            {item.title}
                          </Button>
                        </span>
                      }
                      description={
                        <div>
                          <Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 4, color: '#666' }}>
                            {item.content}
                          </Paragraph>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.createdByName && `${item.createdByName} · `}
                            {new Date(item.createdAt).toLocaleString()}
                          </Text>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Spin>
        )}
      </Card>

      {/* 公告详情 Modal */}
      <Modal
        title={detailItem ? (
          <span>
            {detailItem.type === 'urgent' && <ExclamationCircleOutlined style={{ color: '#C0564B', marginRight: 8 }} />}
            {detailItem.type === 'important' && <WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />}
            {detailItem.title}
          </span>
        ) : ''}
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setDetailItem(null); }}
        footer={detailItem?.isRead ? null : (
          <Button type="primary" onClick={async () => {
            if (detailItem) {
              try {
                await announcementApi.markAsRead(detailItem.id);
                emitNotificationReadStateChanged();
                setAnnouncements(current => current.map(announcement => (
                  announcement.id === detailItem.id ? { ...announcement, isRead: true } : announcement
                )));
              } catch {
                return;
              }
            }
            setDetailOpen(false);
            setDetailItem(null);
          }}>
            我知道了
          </Button>
        )}
        width={600}
      >
        {detailItem && (
          <div>
            <Descriptions size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型">
                {announTypeTag(detailItem.type)}
              </Descriptions.Item>
              <Descriptions.Item label="发布人">{detailItem.createdByName || '-'}</Descriptions.Item>
              <Descriptions.Item label="发布时间" span={2}>
                {new Date(detailItem.createdAt).toLocaleString()}
              </Descriptions.Item>
            </Descriptions>
            <div style={{
              padding: 16,
              background: '#f9fafb',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.8,
              fontSize: 14,
            }}>
              {detailItem.content || '无内容'}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
