import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
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
const PAGE_SIZE = 20;

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
  total,
  page,
  onPageChange,
  showApplicant,
  onWithdraw,
  withdrawingId,
}: {
  data: PermissionRequestItem[];
  loading: boolean;
  onReload: () => void;
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  showApplicant?: boolean;
  onWithdraw?: (id: number) => Promise<void>;
  withdrawingId?: number | null;
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
              <Button
                type="link"
                size="small"
                icon={<RollbackOutlined />}
                loading={withdrawingId === record.id}
                disabled={withdrawingId !== null && withdrawingId !== record.id}
              >
                撤回
              </Button>
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
      pagination={{
        current: page,
        pageSize: PAGE_SIZE,
        total,
        showSizeChanger: false,
        showTotal: (count) => `共 ${count} 条`,
        onChange: onPageChange,
      }}
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
  const canCreate = hasPermission('permission_request:create');
  const canViewSelf = hasPermission('permission_request:view:self');
  const canViewAll = hasPermission('permission_request:view:all');
  const canManageGrant = hasPermission('permission_grant:manage');
  const [form] = Form.useForm();
  const [grantablePermissions, setGrantablePermissions] = useState<Permission[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<{ id: number; realName: string; username?: string }[]>([]);
  const [myRequests, setMyRequests] = useState<PermissionRequestItem[]>([]);
  const [myTotal, setMyTotal] = useState(0);
  const [myPage, setMyPage] = useState(1);
  const [allRequests, setAllRequests] = useState<PermissionRequestItem[]>([]);
  const [allTotal, setAllTotal] = useState(0);
  const [allPage, setAllPage] = useState(1);
  const [grants, setGrants] = useState<UserPermissionGrant[]>([]);
  const [grantTotal, setGrantTotal] = useState(0);
  const [grantPage, setGrantPage] = useState(1);
  const [loading, setLoading] = useState(false);       // 我的申请列表
  const [baseLoading, setBaseLoading] = useState(false); // 基础选项（权限定义/范围选项）
  const [submitLoading, setSubmitLoading] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<number | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [grantLoading, setGrantLoading] = useState(false);
  const [selectedPermissionCode, setSelectedPermissionCode] = useState<string>();
  const [selectedScopeType, setSelectedScopeType] = useState<string>();
  const [grantStatus, setGrantStatus] = useState('active');
  const [grantUserId, setGrantUserId] = useState<number>();
  const [tabKey, setTabKey] = useState(() => (
    canCreate ? 'apply' : canViewSelf ? 'my' : canViewAll ? 'all' : canManageGrant ? 'grants' : ''
  ));

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
    if (!canCreate && !canManageGrant) return;
    setBaseLoading(true);
    try {
      const [permissionRes, scopeResponses] = await Promise.all([
        permissionRequestApi.getGrantablePermissions(),
        canCreate
          ? Promise.all([systemApi.getDepartments(), systemApi.getGroups(), systemApi.getActiveProjects()])
          : Promise.resolve(null),
      ]);
      if (permissionRes.data) setGrantablePermissions(permissionRes.data);
      if (scopeResponses) {
        const [deptRes, groupRes, projectRes] = scopeResponses;
        if (deptRes.data) setDepartments(deptRes.data);
        if (groupRes.data) setGroups(groupRes.data);
        if (projectRes.data) setProjects(projectRes.data as Project[]);
      }
    } catch (error) {
      message.error(getErrorMessage(error, '权限申请基础数据加载失败'));
    } finally {
      setBaseLoading(false);
    }
  };

  const loadMyRequests = async (page = myPage) => {
    if (!canViewSelf) return;
    setLoading(true);
    try {
      const res = await permissionRequestApi.getMyRequests({ page, pageSize: PAGE_SIZE });
      if (res.data) {
        setMyRequests(res.data.list);
        setMyTotal(res.data.total);
        setMyPage(res.data.page);
      }
    } catch (error) {
      message.error(getErrorMessage(error, '我的权限申请加载失败'));
      setMyRequests([]);
      setMyTotal(0);
    } finally {
      setLoading(false);
    }
  };

  const loadAllRequests = async (page = allPage) => {
    if (!canViewAll) return;
    setAllLoading(true);
    try {
      const res = await permissionRequestApi.getAllRequests({ page, pageSize: PAGE_SIZE });
      if (res.data) {
        setAllRequests(res.data.list);
        setAllTotal(res.data.total);
        setAllPage(res.data.page);
      }
    } catch (error) {
      message.error(getErrorMessage(error, '全部权限申请加载失败'));
      setAllRequests([]);
      setAllTotal(0);
    } finally {
      setAllLoading(false);
    }
  };

  const loadUsers = async () => {
    if (!canManageGrant) return;
    try {
      const res = await permissionRequestApi.getUsers();
      if (res.data) setUsers(res.data);
    } catch (error) {
      setUsers([]);
      message.error(getErrorMessage(error, '授权用户加载失败'));
    }
  };

  const loadGrants = async (page = grantPage) => {
    if (!canManageGrant) return;
    setGrantLoading(true);
    try {
      const res = await permissionRequestApi.getGrants({
        page,
        pageSize: PAGE_SIZE,
        status: grantStatus || undefined,
        userId: grantUserId,
      });
      if (res.data) {
        setGrants(res.data.list);
        setGrantTotal(res.data.total);
        setGrantPage(res.data.page);
      }
    } catch (error) {
      message.error(getErrorMessage(error, '授权记录加载失败'));
      setGrants([]);
      setGrantTotal(0);
    } finally {
      setGrantLoading(false);
    }
  };

  useEffect(() => {
    if (canCreate || canManageGrant) loadBase();
    if (canViewSelf) loadMyRequests(1);
    if (canManageGrant) loadUsers();
  }, []);

  useEffect(() => {
    if (tabKey === 'all') loadAllRequests(allPage);
    if (tabKey === 'grants') loadGrants(1);
  }, [tabKey, grantStatus, grantUserId]);

  useEffect(() => {
    const allowedTabs = [
      canCreate && 'apply',
      canViewSelf && 'my',
      canViewAll && 'all',
      canManageGrant && 'grants',
    ].filter(Boolean) as string[];
    if (!allowedTabs.includes(tabKey)) setTabKey(allowedTabs[0] || '');
  }, [canCreate, canManageGrant, canViewAll, canViewSelf, tabKey]);

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
          if (canViewSelf) {
            await loadMyRequests(1);
            setTabKey('my');
          }
        } catch (error) {
          message.error(getErrorMessage(error, '权限申请提交失败'));
        } finally {
          setSubmitLoading(false);
        }
      },
    });
  };

  const handleWithdraw = async (id: number) => {
    if (withdrawingId !== null) return;
    setWithdrawingId(id);
    try {
      await permissionRequestApi.withdraw(id);
      message.success('已撤回');
      await loadMyRequests(myPage);
      if (canViewAll) await loadAllRequests(allPage);
    } catch (error) {
      message.error(getErrorMessage(error, '撤回失败'));
    } finally {
      setWithdrawingId(null);
    }
  };

  const handleRevoke = async (id: number) => {
    let reason = '';
    Modal.confirm({
      title: '撤销授权',
      content: (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary">撤销后用户将立即失去该范围权限，请填写原因以便审计。</Text>
          <TextArea
            autoFocus
            maxLength={255}
            showCount
            rows={3}
            placeholder="请输入撤销原因"
            style={{ marginTop: 12 }}
            onChange={(event) => { reason = event.target.value; }}
          />
        </div>
      ),
      okText: '确认撤销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        if (!reason.trim()) {
          message.warning('请填写撤销原因');
          return Promise.reject();
        }
        try {
          await permissionRequestApi.revokeGrant(id, reason.trim());
          message.success('授权已撤销');
          await loadGrants(grantPage);
        } catch (error) {
          message.error(getErrorMessage(error, '撤销授权失败'));
          return Promise.reject(error);
        }
      },
    });
  };

  const resetApplicationForm = () => {
    form.resetFields();
    setSelectedPermissionCode(undefined);
    setSelectedScopeType(undefined);
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
            <Button type="link" size="small" danger icon={<StopOutlined />} onClick={() => handleRevoke(record.id)}>
              撤销
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const tabItems = [
    ...(canCreate ? [{ key: 'apply', label: '申请开通' }] : []),
    ...(canViewSelf ? [{ key: 'my', label: '我的申请' }] : []),
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

        {!tabItems.length && (
          <Alert type="warning" showIcon message="当前角色尚未配置权限申请相关操作权限" />
        )}

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
                loading={baseLoading}
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

            {selectedPermission?.description && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={selectedPermission.name}
                description={selectedPermission.description}
              />
            )}

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
              <Button onClick={resetApplicationForm}>重置</Button>
            </Space>
          </Form>
        )}

        {tabKey === 'my' && (
          <RequestTable
            data={myRequests}
            loading={loading}
            onReload={() => loadMyRequests(myPage)}
            total={myTotal}
            page={myPage}
            onPageChange={loadMyRequests}
            onWithdraw={handleWithdraw}
            withdrawingId={withdrawingId}
          />
        )}

        {tabKey === 'all' && (
          <RequestTable
            data={allRequests}
            loading={allLoading}
            onReload={() => loadAllRequests(allPage)}
            total={allTotal}
            page={allPage}
            onPageChange={loadAllRequests}
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
                onChange={(value) => {
                  setGrantUserId(value);
                  setGrantPage(1);
                }}
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
                onChange={(value) => {
                  setGrantStatus(value);
                  setGrantPage(1);
                }}
              />
              <Button icon={<ReloadOutlined />} onClick={() => loadGrants(grantPage)}>刷新</Button>
            </div>
            <Table
              rowKey="id"
              loading={grantLoading}
              columns={grantColumns}
              dataSource={grants}
              size="middle"
              scroll={{ x: 1100 }}
              pagination={{
                current: grantPage,
                pageSize: PAGE_SIZE,
                total: grantTotal,
                showSizeChanger: false,
                showTotal: (count) => `共 ${count} 条`,
                onChange: loadGrants,
              }}
            />
          </>
        )}
      </Card>
    </div>
  );
}

export default PermissionRequestPage;
