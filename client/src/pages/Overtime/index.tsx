import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, InputNumber, Select,
  DatePicker, Tag, message, Typography, Row, Col, Popconfirm, Alert,
  Descriptions,
} from 'antd';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { overtimeApi } from '../../api/overtime';
import { approvalApi } from '../../api/approval';
import { systemApi } from '../../api/system';
import { OvertimeApplication, statusMap, overtimeTypeMap } from '../../types';
import { usePermission } from '../../hooks/usePermission';

const { Title } = Typography;
const { TextArea } = Input;

export default function Overtime() {
  const [data, setData] = useState<OvertimeApplication[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<OvertimeApplication | null>(null);
  const [projects, setProjects] = useState<{ id: number; name: string; code: string }[]>([]);
  const [holidays, setHolidays] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const { hasPermission } = usePermission();
  const navigate = useNavigate();

  const canCreate = hasPermission('overtime:create');
  const canViewSelf = hasPermission('overtime:view:self');
  const canDelete = hasPermission('overtime:delete:self');
  const canUpdate = hasPermission('overtime:update:self');
  const canSubmit = hasPermission('overtime:submit:self');
  const canWithdraw = hasPermission('approval:withdraw:self');

  const getErrorMessage = (error: unknown, fallback: string) => {
    const e = error as { response?: { data?: { message?: string } }; message?: string };
    return e?.response?.data?.message || e?.message || fallback;
  };

  useEffect(() => { void loadData(page); }, [page, canViewSelf]);
  useEffect(() => {
    if (canSubmit && (canCreate || canUpdate)) void loadProjects();
  }, [canCreate, canSubmit, canUpdate]);

  // 加载节假日日历用于客户端预览加班类型（服务端写入时会权威推断，此处仅为展示）
  useEffect(() => {
    const now = new Date();
    const years = [now.getFullYear(), now.getFullYear() + 1];
    Promise.all(years.map(y => systemApi.getHolidays(y).catch(() => ({ code: 0, data: [] }))))
      .then((results) => {
        const map = new Map<string, boolean>();
        results.forEach(res => {
          (res.data || []).forEach((h: { date: string; isWorkday: boolean }) => map.set(h.date, !!h.isWorkday));
        });
        setHolidays(map);
      })
      .catch(() => undefined);
  }, []);

  /** 客户端预判加班类型（节假日日历 + 自然周周末；最终以服务端写入为准） */
  const inferOvertimeType = (date: dayjs.Dayjs | undefined): string => {
    if (!date) return '';
    const dateStr = date.format('YYYY-MM-DD');
    const flag = holidays.get(dateStr);
    if (flag === false) return 'holiday';
    if (flag === true) return 'weekday';
    const dow = date.day();
    return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
  };

  // 日期或节假日日历变更时，自动刷新加班类型（只读展示）
  const watchedDate = Form.useWatch('date', form);
  useEffect(() => {
    if (watchedDate) {
      form.setFieldValue('overtimeType', inferOvertimeType(watchedDate));
    }
  }, [watchedDate, holidays]);

  const loadData = async (targetPage = page) => {
    if (!canViewSelf) {
      setData([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await overtimeApi.getMy({ page: targetPage, pageSize: 20 });
      setData(res.data?.list || []);
      setTotal(res.data?.total || 0);
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
          if (editingRecord) {
            await overtimeApi.updateAndSubmit(editingRecord.id, payload);
          } else {
            await overtimeApi.createAndSubmit(payload);
          }
          message.success(editingRecord ? '修改后已重新提交审批' : '已提交审批');
          setModalOpen(false);
          setEditingRecord(null);
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

  const openCreate = () => {
    setEditingRecord(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (record: OvertimeApplication) => {
    setEditingRecord(record);
    form.setFieldsValue({
      date: dayjs(record.date),
      projectId: record.projectId,
      overtimeType: record.overtimeType,
      days: Number(record.days),
      reason: record.reason,
    });
    setModalOpen(true);
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
          {record.status === 'submitted' && canWithdraw && (
            <Popconfirm title="确定撤回此加班申请？" onConfirm={() => handleWithdraw(record)}>
              <Button type="link" size="small">撤回</Button>
            </Popconfirm>
          )}
          {canUpdate && canSubmit && ['draft', 'rejected', 'withdrawn'].includes(record.status) && (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
              {record.status === 'draft' ? '编辑并提交' : '修改并重提'}
            </Button>
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
              {canCreate && canSubmit && (
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
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
          action={<Button size="small" onClick={() => void loadData(page)}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ borderRadius: 12 }}>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={data}
          pagination={{
            current: page,
            pageSize: 20,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: setPage,
          }}
        />
      </Card>

      <Modal
        title={editingRecord ? '修改加班申请' : '新增加班申请'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditingRecord(null); form.resetFields(); }}
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
          <Form.Item name="overtimeType" label="加班类型" rules={[{ required: true }]}
            extra="类型由系统按节假日日历自动判定，选择日期后自动填充。">
            <Select disabled placeholder="选择日期后自动判定" options={[
              { label: '周末加班', value: 'weekend' },
              { label: '节假日加班', value: 'holiday' },
              { label: '工作日加班', value: 'weekday' },
            ]} />
          </Form.Item>
          <Form.Item name="days" label="加班时长（天）" rules={[{ required: true, message: '请输入加班时长' }]}>
            <InputNumber min={0.5} max={1} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="加班原因">
            <TextArea rows={3} placeholder="请说明加班原因" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
