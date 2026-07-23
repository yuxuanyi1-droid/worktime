import { useEffect, useRef, useState } from 'react';
import { Alert, Card, Button, message, Typography, Table, Modal, Input, Form, Space, Tag, Popconfirm } from 'antd';
import { PlusOutlined, CopyOutlined, DeleteOutlined, KeyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { patApi, type PersonalAccessToken } from '../../api/pat';

const { Title, Text, Paragraph } = Typography;

export default function PatPage() {
  const [list, setList] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const loadRequestId = useRef(0);

  const load = async () => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await patApi.list();
      if (requestId === loadRequestId.current) setList(res.data || []);
    } catch (e: any) {
      if (requestId === loadRequestId.current) {
        setLoadError(e?.response?.data?.message || e?.message || '访问令牌加载失败');
      }
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    return () => { loadRequestId.current += 1; };
  }, []);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      // 降级：选中文本
      message.warning('复制失败，请手动选中令牌复制');
    }
  };

  const handleCreate = async () => {
    if (creating) return;
    let values: { name: string; expiresAt?: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    try {
      const expiresAt = values.expiresAt ? dayjs(values.expiresAt).toISOString() : undefined;
      const res = await patApi.create({ name: values.name, expiresAt });
      setCreateOpen(false);
      form.resetFields();
      if (res.data?.tokenPlain) {
        message.success('令牌已创建');
        setCreatedToken(res.data.tokenPlain);
      } else {
        message.warning('令牌已创建，但未收到一次性明文。请删除该令牌后重新创建。');
      }
      await load();
    } catch {
      // request 拦截器已展示服务端错误
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (deletingId !== null) return;
    setDeletingId(id);
    try {
      await patApi.remove(id);
      message.success('令牌已删除');
      await load();
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (name: string, record: PersonalAccessToken) => (
        <Space>
          <KeyOutlined style={{ color: '#6B8F71' }} />
          <Text strong>{name}</Text>
          {record.name === '默认令牌' && <Tag color="green">默认</Tag>}
        </Space>
      ),
    },
    {
      title: '令牌',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (prefix: string) => <Text code>{prefix}...</Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (t: string) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '最近使用',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      width: 160,
      render: (t: string | null) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '从未使用'),
    },
    {
      title: '过期',
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 140,
      render: (t: string | null) => {
        if (!t) return <Tag>永不过期</Tag>;
        const expired = dayjs(t).isBefore(dayjs());
        return expired
          ? <Tag color="red">已过期 {dayjs(t).format('YYYY-MM-DD HH:mm')}</Tag>
          : dayjs(t).format('YYYY-MM-DD HH:mm');
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: any, record: PersonalAccessToken) => (
        <Popconfirm
          title="删除此令牌？"
          description="删除后使用该令牌的程序将无法访问系统"
          onConfirm={() => handleDelete(record.id)}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={deletingId !== null}
        >
          <Button type="text" danger size="small" icon={<DeleteOutlined />} loading={deletingId === record.id}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em', margin: 0 }}>
          访问令牌
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建令牌
        </Button>
      </div>

      <Card style={{ borderRadius: 12, marginBottom: 16 }}>
        {loadError && (
          <Alert
            type="error"
            showIcon
            message={loadError}
            action={<Button size="small" onClick={load}>重试</Button>}
            style={{ marginBottom: 16 }}
          />
        )}
        <Paragraph type="secondary" style={{ marginBottom: 16, fontSize: 13 }}>
          访问令牌（PAT）仅用于 Cursor 等外部工具通过 <Text code>Authorization: Bearer &lt;令牌&gt;</Text> 调用本系统 API。
          内置 AI 助手使用服务端短期凭证，不需要在此创建 PAT。PAT 继承你的账号权限，请妥善保管。
          每个账号最多保留 20 个未过期令牌。
        </Paragraph>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={list}
          loading={loading}
          pagination={false}
          size="middle"
        />
      </Card>

      <Modal
        title="新建访问令牌"
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => {
          if (creating) return;
          setCreateOpen(false);
          form.resetFields();
        }}
        okText="创建令牌"
        cancelText="取消"
        confirmLoading={creating}
        maskClosable={!creating}
        keyboard={!creating}
        closable={!creating}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="令牌名称"
            rules={[{ required: true, message: '请输入令牌名称' }, { max: 100, message: '最多 100 字符' }]}
          >
            <Input placeholder="如：Cursor 集成 / 本地调试" maxLength={100} />
          </Form.Item>
          <Form.Item name="expiresAt" label="过期时间（可选）" tooltip="留空则永不过期">
            <Input type="datetime-local" min={dayjs().format('YYYY-MM-DDTHH:mm')} style={{ width: '100%' }} />
          </Form.Item>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            令牌只会在创建后显示一次，关闭后无法再次查看，请立即复制并妥善保存。
          </Paragraph>
        </Form>
      </Modal>

      <Modal
        title="访问令牌已创建"
        open={!!createdToken}
        onCancel={() => setCreatedToken('')}
        footer={[
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => handleCopy(createdToken)}>
            复制令牌
          </Button>,
          <Button key="close" onClick={() => setCreatedToken('')}>我已保存</Button>,
        ]}
        closable={false}
        maskClosable={false}
        keyboard={false}
      >
        <Paragraph type="warning">该令牌只显示一次，关闭后无法恢复。若丢失，请删除并重新创建。</Paragraph>
        <Input.TextArea value={createdToken} readOnly autoSize={{ minRows: 2, maxRows: 4 }} />
      </Modal>
    </div>
  );
}
