import { useEffect, useState } from 'react';
import {
  Card, Tabs, Table, Button, Space, Tag, Typography, Empty, Modal, Badge, message,
  List, Spin, Input, Descriptions,
} from 'antd';
import {
  BellOutlined, NotificationOutlined, CheckCircleOutlined, DeleteOutlined,
  InfoCircleOutlined, WarningOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { notificationApi, NotificationItem, announcementApi, AnnouncementItem } from '../../api/notification';
import { useNavigate } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;

export default function NotificationCenter() {
  const navigate = useNavigate();
  const [tabKey, setTabKey] = useState('notif');
  const [notifLoading, setNotifLoading] = useState(false);
  const [announLoading, setAnnounLoading] = useState(false);

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
    setNotifLoading(true);
    try {
      const res = await notificationApi.getList({ page: notifPage, pageSize: 20 });
      if (res.data) { setNotifications(res.data.list); setNotifTotal(res.data.total); }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '通知加载失败');
    }
    setNotifLoading(false);
  };

  const loadAnnouncements = async () => {
    setAnnounLoading(true);
    try {
      const res = await announcementApi.getMyList({ page: announPage, pageSize: 20 });
      if (res.data) { setAnnouncements(res.data.list); setAnnounTotal(res.data.total); }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '公告加载失败');
    }
    setAnnounLoading(false);
  };

  useEffect(() => { loadNotifications(); }, [notifPage]);
  useEffect(() => { loadAnnouncements(); }, [announPage]);

  const handleNotifClick = async (item: NotificationItem) => {
    if (!item.isRead) {
      try {
        await notificationApi.markAsRead([item.id]);
        loadNotifications();
      } catch {}
    }
    if (item.targetType && item.targetId) {
      navigate(`/approval/detail/${item.targetType}/${item.targetId}`);
    }
  };

  const handleAnnounClick = async (item: AnnouncementItem) => {
    if (!item.isRead) {
      try {
        await announcementApi.markAsRead(item.id);
        loadAnnouncements();
      } catch {}
    }
    setDetailItem(item);
    setDetailOpen(true);
  };

  const handleMarkAllReadNotif = async () => {
    await notificationApi.markAllAsRead();
    loadNotifications();
  };

  const handleMarkAllReadAnnoun = async () => {
    await announcementApi.markAllAsRead();
    loadAnnouncements();
  };

  const typeIcon = (type: string) => {
    if (type === 'approval_pending') return <CheckCircleOutlined style={{ color: '#6B8F71' }} />;
    if (type === 'approval_approved') return <CheckCircleOutlined style={{ color: '#4A8B5E' }} />;
    if (type === 'approval_rejected') return <DeleteOutlined style={{ color: '#C0564B' }} />;
    return <BellOutlined />;
  };

  const typeLabel: Record<string, string> = {
    approval_pending: '待审批', approval_approved: '已通过', approval_rejected: '已驳回', system: '系统',
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
        <span style={{ fontWeight: r.isRead ? 400 : 600, cursor: 'pointer' }}
          onClick={() => handleNotifClick(r)}>
          {t}
        </span>
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
            <Button type="link" size="small" onClick={() => handleNotifClick(r)}>标为已读</Button>
          )}
          <Button type="link" size="small" danger onClick={async () => {
            await notificationApi.delete(r.id);
            loadNotifications();
          }}>删除</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>通知中心</Title>
      <Card style={{ borderRadius: 12 }}>
        <Tabs activeKey={tabKey} onChange={(k) => { setTabKey(k); }} items={[
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
          <Button type="link" onClick={tabKey === 'notif' ? handleMarkAllReadNotif : handleMarkAllReadAnnoun}>
            全部标为已读
          </Button>
        }
        />

        {tabKey === 'notif' ? (
          <Table rowKey="id" columns={notifColumns} dataSource={notifications}
            loading={notifLoading}
            pagination={{
              current: notifPage, total: notifTotal, pageSize: 20,
              onChange: setNotifPage, showTotal: (t) => `共 ${t} 条`,
            }}
            size="middle" />
        ) : (
          <Spin spinning={announLoading}>
            {announcements.length === 0 ? (
              <Empty description="暂无系统公告" />
            ) : (
              <List
                dataSource={announcements}
                pagination={{
                  current: announPage, total: announTotal, pageSize: 20,
                  onChange: setAnnounPage, showTotal: (t) => `共 ${t} 条`,
                }}
                renderItem={(item) => (
                  <List.Item
                    style={{
                      cursor: 'pointer',
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
                    onClick={() => handleAnnounClick(item)}
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
                        <span>
                          {announTypeTag(item.type)}
                          <span style={{ fontWeight: item.isRead ? 400 : 600, marginLeft: 4 }}>{item.title}</span>
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
              await announcementApi.markAsRead(detailItem.id);
              loadAnnouncements();
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
