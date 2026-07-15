import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, InputNumber, Select,
  DatePicker, Tag, message, Typography, Row, Col, Popconfirm, Alert,
  Descriptions,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { overtimeApi } from '../../api/overtime';
import { approvalApi } from '../../api/approval';
import { systemApi } from '../../api/system';
import { OvertimeApplication, statusMap, overtimeTypeMap } from '../../types';
import { usePermission } from '../../hooks/usePermission';

const { Title } = Typography;
const { TextArea } = Input;

export default function Overtime() {
  const [data, setData] = useState<OvertimeApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [projects, setProjects] = useState<{ id: number; name: string; code: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const { hasPermission } = usePermission();
  const navigate = useNavigate();

  const canCreate = hasPermission('overtime:create');
  const canDelete = hasPermission('overtime:delete');

  const getErrorMessage = (error: unknown, fallback: string) => {
    const e = error as { response?: { data?: { message?: string } }; message?: string };
    return e?.response?.data?.message || e?.message || fallback;
  };

  useEffect(() => { loadData(); loadProjects(); }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await overtimeApi.getMy({ pageSize: 100 });
      setData(res.data?.list || []);
    } catch (e: any) {
      setData([]);
      setError(e?.response?.data?.message || e?.message || '加班列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  const loadProjects = async () => {
    try {
      const res = await systemApi.getActiveProjects();
      if (res.data) setProjects(res.data);
    } catch (e) {
      message.error(getErrorMessage(e, '项目列表加载失败'));
    }
  };

  const handleSubmit = async (values: any) => {
    const payload = {
      ...values,
      date: values.date.format('YYYY-MM-DD'),
    };
    const projectName = projects.find(p => p.id === payload.projectId)?.name || '-';

    Modal.confirm({
      title: '确认提交加班审批？',
      content: (
        <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
          <Descriptions.Item label="加班日期">{payload.date}</Descriptions.Item>
          <Descriptions.Item label="加班项目">{projectName}</Descriptions.Item>
          <Descriptions.Item label="加班类型">{overtimeTypeMap[payload.overtimeType] || payload.overtimeType}</Descriptions.Item>
          <Descriptions.Item label="加班时长">{payload.days} 天</Descriptions.Item>
        </Descriptions>
      ),
      okText: '提交审批',
      cancelText: '返回修改',
      onOk: async () => {
        setSubmitting(true);
        try {
          await overtimeApi.createAndSubmit(payload);
          message.success('已提交审批');
          setModalOpen(false);
          form.resetFields();
          loadData();
        } catch (e) {
          message.error(getErrorMessage(e, '提交审批失败'));
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  const handleDelete = async (id: number) => {
    try {
      await overtimeApi.delete(id);
      message.success('删除成功');
      loadData();
    } catch (e) {
      message.error(getErrorMessage(e, '删除失败'));
    }
  };

  const handleWithdraw = async (record: OvertimeApplication) => {
    try {
      await approvalApi.withdraw('overtime', record.id);
      message.success('已撤回');
      loadData();
    } catch (e) {
      message.error(getErrorMessage(e, '撤回失败'));
    }
  };

  const columns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 120, sorter: (a: OvertimeApplication, b: OvertimeApplication) => a.date.localeCompare(b.date) },
    { title: '加班项目', key: 'project', width: 140, render: (_: any, r: OvertimeApplication) => r.project?.name || '-' },
    { title: '加班类型', dataIndex: 'overtimeType', key: 'overtimeType', width: 120, render: (v: string) => overtimeTypeMap[v] || v },
    { title: '时长(天)', dataIndex: 'days', key: 'days', width: 100 },
    { title: '加班原因', dataIndex: 'reason', key: 'reason', ellipsis: true },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label}</Tag> },
    {
      title: '操作', key: 'action', width: 120,
      render: (_: any, record: OvertimeApplication) => (
        <Space size={4}>
          {record.status !== 'draft' && (
            <Button
              type="link"
              size="small"
              onClick={() => navigate(`/approval/detail/overtime/${record.id}`)}
            >
              详情
            </Button>
          )}
          {record.status === 'submitted' && (
            <Popconfirm title="确定撤回此加班申请？" onConfirm={() => handleWithdraw(record)}>
              <Button type="link" size="small">撤回</Button>
            </Popconfirm>
          )}
          {canDelete && record.status === 'draft' && (
            <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>加班提报</Title>

      <Card style={{ borderRadius: 12, marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col />
          <Col>
            <Space>
              {canCreate && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalOpen(true); }}>
                  新增加班
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ borderRadius: 12 }}>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={data}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>

      <Modal
        title="新增加班申请"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="提交审批"
        cancelText="取消"
        width={500}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="date" label="加班日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="projectId" label="加班项目" rules={[{ required: true, message: '请选择项目' }]}>
            <Select placeholder="请选择加班项目" showSearch optionFilterProp="label"
              options={projects.map(p => ({ label: p.name, value: p.id }))} />
          </Form.Item>
          <Form.Item name="overtimeType" label="加班类型" rules={[{ required: true }]}>
            <Select placeholder="请选择" options={[
              { label: '周末加班', value: 'weekend' },
              { label: '节假日加班', value: 'holiday' },
              { label: '工作日加班', value: 'weekday' },
            ]} />
          </Form.Item>
          <Form.Item name="days" label="加班时长(天)" rules={[{ required: true }]}>
            <InputNumber min={0.5} max={24} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="加班原因">
            <TextArea rows={3} placeholder="请说明加班原因" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
