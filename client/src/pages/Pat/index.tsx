import { useEffect, useState } from 'react';
import { Card, Button, message, Typography, Table, Modal, Input, Form, Space, Tag, Tooltip, Popconfirm } from 'antd';
import { PlusOutlined, CopyOutlined, DeleteOutlined, KeyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { patApi, type PersonalAccessToken } from '../../api/pat';

const { Title, Text, Paragraph } = Typography;

export default function PatPage() {
  const [list, setList] = useState<PersonalAccessToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await patApi.list();
      setList(res.data || []);
    } catch (e: any) {
      // request 拦截器已弹 message
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
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
    try {
      const values = await form.validateFields();
      const res = await patApi.create({ name: values.name, expiresAt: values.expiresAt || undefined });
      message.success('令牌已创建');
      setCreateOpen(false);
      form.resetFields();
      // 直接复制新建令牌
      if (res.data?.tokenPlain) {
        handleCopy(res.data.tokenPlain);
      }
      load();
    } catch (e: any) {
      // 校验失败或接口报错
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await patApi.remove(id);
      message.success('令牌已删除');
      load();
    } catch {
      // ignore
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
      dataIndex: 'tokenPlain',
      key: 'tokenPlain',
      render: (plain: string) => (
        <Space>
          <Text code style={{ fontSize: 12, maxWidth: 320, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
            {plain}
          </Text>
          <Tooltip title="复制完整令牌">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => handleCopy(plain)} />
          </Tooltip>
        </Space>
      ),
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
      render: (t: string | null) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : <Tag>永不过期</Tag>),
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
        >
          <Button type="text" danger size="small" icon={<DeleteOutlined />}>删除</Button>
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
        <Paragraph type="secondary" style={{ marginBottom: 16, fontSize: 13 }}>
          访问令牌（PAT）用于 pi agent 助手或外部工具（如 Cursor）通过 <Text code>Authorization: Bearer &lt;令牌&gt;</Text> 调用本系统 API。
          令牌与你的账号权限相同，请妥善保管。在 Cursor 等工具中配合 <Text code>SKILL.md</Text> 使用即可自动查询工时、周报等数据。
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
        onCancel={() => { setCreateOpen(false); form.resetFields(); }}
        okText="创建并复制"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="令牌名称"
            rules={[{ required: true, message: '请输入令牌名称' }, { max: 100, message: '最多 100 字符' }]}
          >
            <Input placeholder="如：Cursor 集成 / 本地调试" />
          </Form.Item>
          <Form.Item name="expiresAt" label="过期时间（可选）" tooltip="留空则永不过期">
            <Input type="datetime-local" style={{ width: '100%' }} />
          </Form.Item>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            创建后令牌会立即复制到剪贴板，列表中也会保留明文方便随时复制。
          </Paragraph>
        </Form>
      </Modal>
    </div>
  );
}
