import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  KeyOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { permissionRequestApi } from '../../api/permissionRequest';
import { systemApi } from '../../api/system';
import {
  Department,
  Group,
  Permission,
  PermissionRequestItem,
  Project,
  UserPermissionGrant,
  statusMap,
} from '../../types';
import { usePermission } from '../../hooks/usePermission';

const { Title, Text } = Typography;
const { TextArea } = Input;

const scopeLabels: Record<string, string> = {
  self: '本人',
  group: '组别',
  department: '部门',
  project: '项目',
  global: '全局',
};

const moduleLabels: Record<string, string> = {
  timesheet: '工时',
  overtime: '加班',
  weekly_report: '周报',
  report: '报表',
  project: '项目',
  system: '系统',
  permission_request: '权限申请',
  permission_grant: '授权',
};

const grantStatusMap: Record<string, { label: string; color: string }> = {
  active: { label: '生效中', color: 'success' },
  revoked: { label: '已撤销', color: 'default' },
  expired: { label: '已过期', color: 'warning' },
};

function getErrorMessage(error: unknown, fallback: string) {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
}

function scopeText(scopeType?: string, scopeName?: string | null) {
  if (!scopeType) return '-';
  if (scopeType === 'self' || scopeType === 'global') return scopeLabels[scopeType] || scopeType;
  return `${scopeLabels[scopeType] || scopeType}: ${scopeName || '-'}`;
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-';
}

function RequestTable({
  data,
  loading,
  onReload,
  showApplicant,
  onWithdraw,
}: {
  data: PermissionRequestItem[];
  loading: boolean;
  onReload: () => void;
  showApplicant?: boolean;
  onWithdraw?: (id: number) => void;
}) {
  const navigate = useNavigate();

  const columns = [
    ...(showApplicant ? [{
      title: '申请人',
      dataIndex: ['applicant', 'realName'],
      width: 100,
      render: (_: string, record: PermissionRequestItem) => record.applicant?.realName || '-',
    }] : []),
    {
      title: '申请权限',
      dataIndex: 'permissionName',
      key: 'permissionName',
      minWidth: 220,
      render: (name: string, record: PermissionRequestItem) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{record.permissionCode}</Text>
        </Space>
      ),
    },
    {
      title: '范围',
      key: 'scope',
      width: 170,
      render: (_: unknown, record: PermissionRequestItem) => (
        <Tag color={record.scopeType === 'global' ? 'red' : record.scopeType === 'project' ? 'blue' : 'geekblue'}>
          {scopeText(record.scopeType, record.scopeName)}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={statusMap[status]?.color || 'default'}>
          {status === 'withdrawn' ? '已撤回' : statusMap[status]?.label || status}
        </Tag>
      ),
    },
    {
      title: '审批进度',
      key: 'progress',
      width: 140,
      render: (_: unknown, record: PermissionRequestItem) => {
        if (record.status !== 'submitted') return '-';
        return <Tag color="processing">第 {record.currentStep}/{record.totalSteps} 步</Tag>;
      },
    },
    {
      title: '有效期至',
      dataIndex: 'expiresAt',
      width: 120,
      render: (value?: string | null) => value ? dayjs(value).format('YYYY-MM-DD') : '长期',
    },
    {
      title: '提交时间',
      dataIndex: 'createdAt',
      width: 160,
      render: formatDateTime,
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right' as const,
      render: (_: unknown, record: PermissionRequestItem) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => navigate(`/approval/detail/permission_request/${record.id}`)}>
            详情
          </Button>
          {onWithdraw && record.status === 'submitted' && (
            <Popconfirm title="确定撤回该权限申请？" onConfirm={() => onWithdraw(record.id)}>
              <Button type="link" size="small" icon={<RollbackOutlined />}>撤回</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Table
      rowKey="id"
      loading={loading}
      columns={columns}
      dataSource={data}
      size="middle"
      scroll={{ x: 1000 }}
      pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 条` }}
      title={() => (
        <Button icon={<ReloadOutlined />} onClick={onReload}>
          刷新
        </Button>
      )}
    />
  );
}

function PermissionRequestPage() {
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const [form] = Form.useForm();
  const [grantablePermissions, setGrantablePermissions] = useState<Permission[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<{ id: number; realName: string; username?: string }[]>([]);
  const [myRequests, setMyRequests] = useState<PermissionRequestItem[]>([]);
  const [allRequests, setAllRequests] = useState<PermissionRequestItem[]>([]);
  const [grants, setGrants] = useState<UserPermissionGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [allLoading, setAllLoading] = useState(false);
  const [grantLoading, setGrantLoading] = useState(false);
  const [selectedPermissionCode, setSelectedPermissionCode] = useState<string>();
  const [selectedScopeType, setSelectedScopeType] = useState<string>();
  const [grantStatus, setGrantStatus] = useState('active');
  const [grantUserId, setGrantUserId] = useState<number>();
  const [tabKey, setTabKey] = useState('apply');

  const canViewAll = hasPermission('permission_request:view:all');
  const canManageGrant = hasPermission('permission_grant:manage');

  const selectedPermission = useMemo(
    () => grantablePermissions.find((permission) => permission.code === selectedPermissionCode),
    [grantablePermissions, selectedPermissionCode],
  );

  const permissionOptions = useMemo(() => {
    const grouped = grantablePermissions.reduce<Record<string, Permission[]>>((acc, permission) => {
      const key = moduleLabels[permission.module] || permission.module;
      if (!acc[key]) acc[key] = [];
      acc[key].push(permission);
      return acc;
    }, {});

    return Object.entries(grouped).map(([label, options]) => ({
      label,
      options: options.map((permission) => ({
        label: permission.name,
        value: permission.code,
      })),
    }));
  }, [grantablePermissions]);

  const scopeOptions = useMemo(() => {
    const scopes = selectedPermission?.scopeTypes?.length ? selectedPermission.scopeTypes : ['global'];
    return scopes.map((scope) => ({ label: scopeLabels[scope] || scope, value: scope }));
  }, [selectedPermission]);

  const scopedTargetOptions = useMemo(() => {
    if (selectedScopeType === 'department') {
      return departments.map((item) => ({ label: item.name, value: item.id }));
    }
    if (selectedScopeType === 'group') {
      return groups.map((item) => ({
        label: `${item.department?.name ? `${item.department.name} / ` : ''}${item.name}`,
        value: item.id,
      }));
    }
    if (selectedScopeType === 'project') {
      return projects.map((item) => ({ label: item.name, value: item.id }));
    }
    return [];
  }, [departments, groups, projects, selectedScopeType]);

  const loadBase = async () => {
    setLoading(true);
    try {
      const [permissionRes, deptRes, groupRes, projectRes] = await Promise.all([
        permissionRequestApi.getGrantablePermissions(),
        systemApi.getDepartments(),
        systemApi.getGroups(),
        systemApi.getActiveProjects(),
      ]);
      if (permissionRes.data) setGrantablePermissions(permissionRes.data);
      if (deptRes.data) setDepartments(deptRes.data);
      if (groupRes.data) setGroups(groupRes.data);
      if (projectRes.data) setProjects(projectRes.data as Project[]);
    } catch (error) {
      message.error(getErrorMessage(error, '权限申请基础数据加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const loadMyRequests = async () => {
    setLoading(true);
    try {
      const res = await permissionRequestApi.getMyRequests({ pageSize: 100 });
      if (res.data) setMyRequests(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '我的权限申请加载失败'));
      setMyRequests([]);
    } finally {
      setLoading(false);
    }
  };

  const loadAllRequests = async () => {
    if (!canViewAll) return;
    setAllLoading(true);
    try {
      const res = await permissionRequestApi.getAllRequests({ pageSize: 100 });
      if (res.data) setAllRequests(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '全部权限申请加载失败'));
      setAllRequests([]);
    } finally {
      setAllLoading(false);
    }
  };

  const loadUsers = async () => {
    if (!canManageGrant) return;
    try {
      const res = await permissionRequestApi.getUsers();
      if (res.data) setUsers(res.data);
    } catch {
      setUsers([]);
    }
  };

  const loadGrants = async () => {
    if (!canManageGrant) return;
    setGrantLoading(true);
    try {
      const res = await permissionRequestApi.getGrants({
        pageSize: 100,
        status: grantStatus || undefined,
        userId: grantUserId,
      });
      if (res.data) setGrants(res.data.list);
    } catch (error) {
      message.error(getErrorMessage(error, '授权记录加载失败'));
      setGrants([]);
    } finally {
      setGrantLoading(false);
    }
  };

  useEffect(() => {
    loadBase();
    loadMyRequests();
    loadUsers();
  }, []);

  useEffect(() => {
    if (tabKey === 'all') loadAllRequests();
    if (tabKey === 'grants') loadGrants();
  }, [tabKey, grantStatus, grantUserId]);

  const handleSubmit = async (values: any) => {
    const permission = grantablePermissions.find((item) => item.code === values.permissionCode);
    const targetRequired = !['self', 'global'].includes(values.scopeType);
    if (targetRequired && !values.scopeId) {
      message.warning(`请选择${scopeLabels[values.scopeType] || '权限范围'}`);
      return;
    }

    Modal.confirm({
      title: '提交权限申请',
      content: `确认申请开通「${permission?.name || values.permissionCode}」吗？`,
      okText: '提交',
      cancelText: '取消',
      onOk: async () => {
        setSubmitLoading(true);
        try {
          await permissionRequestApi.create({
            permissionCode: values.permissionCode,
            scopeType: values.scopeType,
            scopeId: targetRequired ? values.scopeId : null,
            reason: values.reason,
            expiresAt: values.expiresAt ? values.expiresAt.format('YYYY-MM-DD') : null,
          });
          message.success('权限申请已提交');
          form.resetFields();
          setSelectedPermissionCode(undefined);
          setSelectedScopeType(undefined);
          await loadMyRequests();
          setTabKey('my');
        } catch (error) {
          message.error(getErrorMessage(error, '权限申请提交失败'));
        } finally {
          setSubmitLoading(false);
        }
      },
    });
  };

  const handleWithdraw = async (id: number) => {
    try {
      await permissionRequestApi.withdraw(id);
      message.success('已撤回');
      await loadMyRequests();
      if (canViewAll) await loadAllRequests();
    } catch (error) {
      message.error(getErrorMessage(error, '撤回失败'));
    }
  };

  const handleRevoke = async (id: number) => {
    try {
      await permissionRequestApi.revokeGrant(id);
      message.success('授权已撤销');
      await loadGrants();
    } catch (error) {
      message.error(getErrorMessage(error, '撤销授权失败'));
    }
  };

  const grantColumns = [
    {
      title: '授权用户',
      key: 'user',
      width: 130,
      render: (_: unknown, record: UserPermissionGrant) => record.user?.realName || `用户 ${record.userId}`,
    },
    {
      title: '权限',
      dataIndex: 'permissionCode',
      minWidth: 260,
      render: (code: string) => {
        const permission = grantablePermissions.find((item) => item.code === code);
        return (
          <Space direction="vertical" size={0}>
            <Text strong>{permission?.name || code}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{code}</Text>
          </Space>
        );
      },
    },
    {
      title: '范围',
      key: 'scope',
      width: 170,
      render: (_: unknown, record: UserPermissionGrant) => (
        <Tag color={record.scopeType === 'global' ? 'red' : 'geekblue'}>
          {scopeText(record.scopeType, record.scopeName)}
        </Tag>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 90,
      render: (source: string) => source === 'request' ? '审批开通' : source,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={grantStatusMap[status]?.color || 'default'}>{grantStatusMap[status]?.label || status}</Tag>
      ),
    },
    {
      title: '有效期',
      dataIndex: 'expiresAt',
      width: 120,
      render: (value?: string | null) => value ? dayjs(value).format('YYYY-MM-DD') : '长期',
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: formatDateTime,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      fixed: 'right' as const,
      render: (_: unknown, record: UserPermissionGrant) => (
        <Space size={4}>
          {record.requestId && (
            <Button type="link" size="small" onClick={() => navigate(`/approval/detail/permission_request/${record.requestId}`)}>
              审批详情
            </Button>
          )}
          {record.status === 'active' && (
            <Popconfirm title="确定撤销该授权？" onConfirm={() => handleRevoke(record.id)}>
              <Button type="link" size="small" danger icon={<StopOutlined />}>撤销</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const tabItems = [
    { key: 'apply', label: '申请开通' },
    { key: 'my', label: '我的申请' },
    ...(canViewAll ? [{ key: 'all', label: '全部申请' }] : []),
    ...(canManageGrant ? [{ key: 'grants', label: '授权管理' }] : []),
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: 0 }}>
        <KeyOutlined style={{ marginRight: 8 }} />
        权限申请
      </Title>

      <Card style={{ borderRadius: 12 }}>
        <Tabs activeKey={tabKey} onChange={setTabKey} items={tabItems} />

        {tabKey === 'apply' && (
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
            style={{ maxWidth: 760 }}
          >
            <Form.Item
              name="permissionCode"
              label="申请权限"
              rules={[{ required: true, message: '请选择要申请的权限' }]}
            >
              <Select
                loading={loading}
                showSearch
                optionFilterProp="label"
                placeholder="选择需要开通的权限"
                options={permissionOptions}
                onChange={(value) => {
                  const permission = grantablePermissions.find((item) => item.code === value);
                  const firstScope = permission?.scopeTypes?.[0] || 'global';
                  setSelectedPermissionCode(value);
                  setSelectedScopeType(firstScope);
                  form.setFieldsValue({ scopeType: firstScope, scopeId: undefined });
                }}
              />
            </Form.Item>

            <Space size={16} align="start" style={{ width: '100%' }}>
              <Form.Item
                name="scopeType"
                label="权限范围"
                rules={[{ required: true, message: '请选择权限范围' }]}
                style={{ width: 180 }}
              >
                <Select
                  placeholder="选择范围"
                  options={scopeOptions}
                  disabled={!selectedPermission}
                  onChange={(value) => {
                    setSelectedScopeType(value);
                    form.setFieldsValue({ scopeId: undefined });
                  }}
                />
              </Form.Item>
              {!['self', 'global', undefined].includes(selectedScopeType) && (
                <Form.Item
                  name="scopeId"
                  label={scopeLabels[selectedScopeType || ''] || '具体范围'}
                  rules={[{ required: true, message: '请选择具体范围' }]}
                  style={{ flex: 1, minWidth: 300 }}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="选择具体范围"
                    options={scopedTargetOptions}
                  />
                </Form.Item>
              )}
              <Form.Item name="expiresAt" label="有效期至" style={{ width: 180 }}>
                <DatePicker
                  style={{ width: '100%' }}
                  disabledDate={(date) => !!date && date < dayjs().startOf('day')}
                  placeholder="长期可不填"
                />
              </Form.Item>
            </Space>

            <Form.Item
              name="reason"
              label="申请原因"
              rules={[
                { required: true, message: '请填写申请原因' },
                { max: 1000, message: '申请原因不能超过1000字' },
              ]}
            >
              <TextArea rows={4} placeholder="说明业务场景、需要查看或维护的范围" />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" icon={<SendOutlined />} loading={submitLoading}>
                提交审批
              </Button>
              <Button onClick={() => form.resetFields()}>重置</Button>
            </Space>
          </Form>
        )}

        {tabKey === 'my' && (
          <RequestTable
            data={myRequests}
            loading={loading}
            onReload={loadMyRequests}
            onWithdraw={handleWithdraw}
          />
        )}

        {tabKey === 'all' && (
          <RequestTable
            data={allRequests}
            loading={allLoading}
            onReload={loadAllRequests}
            showApplicant
          />
        )}

        {tabKey === 'grants' && (
          <>
            <div style={{ marginBottom: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="授权用户"
                style={{ width: 180 }}
                options={users.map((user) => ({ label: `${user.realName}${user.username ? ` (${user.username})` : ''}`, value: user.id }))}
                onChange={setGrantUserId}
              />
              <Select
                placeholder="授权状态"
                style={{ width: 140 }}
                value={grantStatus}
                options={[
                  { label: '生效中', value: 'active' },
                  { label: '已撤销', value: 'revoked' },
                  { label: '已过期', value: 'expired' },
                ]}
                onChange={setGrantStatus}
              />
              <Button icon={<ReloadOutlined />} onClick={loadGrants}>刷新</Button>
            </div>
            <Table
              rowKey="id"
              loading={grantLoading}
              columns={grantColumns}
              dataSource={grants}
              size="middle"
              scroll={{ x: 1100 }}
              pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 条` }}
            />
          </>
        )}
      </Card>
    </div>
  );
}

export default PermissionRequestPage;
