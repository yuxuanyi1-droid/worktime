import { useEffect, useState, type ReactNode } from 'react';
import {
  Card, Tabs, Table, Button, Space, Modal, Form, Input, Select, Tag, message,
  Typography, Row, Col, Popconfirm, Switch, InputNumber, Tree, Tooltip, Empty, Radio,
  Progress, Descriptions, Statistic, Badge, List, TreeSelect, Alert, Checkbox,
  DatePicker,
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined,
  UserOutlined, ApartmentOutlined, TeamOutlined, SettingOutlined,
  NotificationOutlined, EyeOutlined, WarningOutlined, InfoCircleOutlined,
  ExclamationCircleOutlined, CopyOutlined, LockOutlined, SearchOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { systemApi, UserListItem, SimpleUser, TimesheetReminderConfig } from '../../api/system';
import { Department, Group, Role, Permission, Project, ProjectSE, ProjectWorkloadAllocation, ApprovalFlow, ApprovalFlowStep, stepTypeMap } from '../../types';
import { announcementApi, AnnouncementItem, AnnouncementStats } from '../../api/notification';
import { useAppStore } from '../../stores/appStore';
import { usePermission } from '../../hooks/usePermission';
import { auditApi, AuditLogItem } from '../../api/audit';

const { Title, Text } = Typography;

function PermissionGuard({ permission, children }: { permission: string; children: ReactNode }) {
  const { hasPermission } = usePermission();
  return hasPermission(permission) ? <>{children}</> : null;
}

const systemTabOptions = [
  { key: 'org', label: '\u7ec4\u7ec7\u67b6\u6784', permission: 'system:org:manage' },
  { key: 'user', label: '\u7528\u6237\u7ba1\u7406', permission: 'system:user:manage' },
  { key: 'role', label: '\u89d2\u8272\u6743\u9650', permission: 'system:role:manage' },
  { key: 'approval-flow', label: '\u5ba1\u6279\u6d41\u7a0b', permission: 'system:approval_flow:manage' },
  { key: 'announcement', label: '\u516c\u544a\u7ba1\u7406', permission: 'system:announcement:view' },
  { key: 'audit', label: '审计日志', permission: 'system:audit:view' },
  { key: 'settings', label: '\u7cfb\u7edf\u8bbe\u7f6e', permission: 'system:settings:manage' },
];

export default function System() {
  const { hasPermission } = usePermission();
  const [tabKey, setTabKey] = useState('org');
  const tabItems = systemTabOptions.filter((item) => hasPermission(item.permission));
  const activeTabKey = tabItems.some((item) => item.key === tabKey) ? tabKey : tabItems[0]?.key;

  useEffect(() => {
    if (activeTabKey && activeTabKey !== tabKey) {
      setTabKey(activeTabKey);
    }
  }, [activeTabKey, tabKey]);

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>{'\u7cfb\u7edf\u7ba1\u7406'}</Title>
      <Card style={{ borderRadius: 12 }}>
        {tabItems.length === 0 ? (
          <Empty description={'\u6682\u65e0\u53ef\u7ba1\u7406\u6a21\u5757'} />
        ) : (
          <Tabs activeKey={activeTabKey} onChange={setTabKey} items={tabItems.map(({ key, label }) => ({ key, label }))} />
        )}

        {activeTabKey === 'org' && <OrgTab />}
        {activeTabKey === 'user' && <UserTab />}
        {activeTabKey === 'role' && <RoleTab />}
        {activeTabKey === 'approval-flow' && <ApprovalFlowTab />}
        {activeTabKey === 'announcement' && <AnnouncementTab />}
        {activeTabKey === 'audit' && <AuditTab />}
        {activeTabKey === 'settings' && <SettingsTab />}
      </Card>
    </div>
  );
}

// ==================== 组织架构（可设置部门/组负责人，审批流程依赖此字段） ====================
function OrgTab() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groupTree, setGroupTree] = useState<any[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  // 设置负责人弹窗状态：type 标识组/部门，id/name 为目标，可选 leaderName 用于标题展示
  const [leaderModal, setLeaderModal] = useState<{ type: 'group' | 'dept'; id: number; name: string } | null>(null);
  const [leaderForm] = Form.useForm();
  const [allUsers, setAllUsers] = useState<SimpleUser[]>([]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [deptRes, usersRes] = await Promise.all([
      systemApi.getDepartments(),
      systemApi.getAllUsers(),
    ]);
    if (deptRes.data) setDepartments(deptRes.data);
    if (usersRes.data) setAllUsers(usersRes.data);

    // 根据是否选中部门加载对应分组树
    if (selectedDeptId) {
      const treeRes = await systemApi.getGroupTree(selectedDeptId);
      if (treeRes.data) setGroupTree(treeRes.data);
    } else {
      // 未选中部门时加载所有分组
      const treeRes = await systemApi.getGroupTree();
      if (treeRes.data) setGroupTree(treeRes.data);
    }
  };

  useEffect(() => { load(); }, [selectedDeptId]);

  // 打开设置负责人弹窗（e.stopPropagation 防止触发树节点选中）
  const openLeaderModal = (e: any, type: 'group' | 'dept', id: number, name: string, currentLeaderId?: number) => {
    e.stopPropagation();
    setLeaderModal({ type, id, name });
    leaderForm.setFieldsValue({ leaderId: currentLeaderId ?? undefined });
  };

  // 提交设置负责人
  const handleLeaderSave = async (values: any) => {
    if (!leaderModal) return;
    const leaderId = values.leaderId ?? null;
    setSaving(true);
    try {
      if (leaderModal.type === 'group') {
        await systemApi.updateGroup(leaderModal.id, { leaderId });
      } else {
        await systemApi.updateDepartment(leaderModal.id, { leaderId });
      }
      message.success('设置成功');
      setLeaderModal(null);
      leaderForm.resetFields();
      await load();
    } catch {
      // 错误信息已由 request 拦截器统一提示
    } finally {
      setSaving(false);
    }
  };

  // 将分组树转为 Ant Design Tree 结构
  const buildTreeData = (groups: any[]): any[] => {
    return groups.map(g => ({
      key: `group-${g.id}`,
      title: (
        <span>
          <TeamOutlined style={{ marginRight: 6 }} />
          {g.name}
          {g.leader && <Tag color="blue" style={{ marginLeft: 8, fontSize: 12 }}>负责人: {g.leader.realName}</Tag>}
          {g.members?.length > 0 && <Tag style={{ marginLeft: 4, fontSize: 11, color: '#7A7060' }}>{g.members.length}人</Tag>}
          <PermissionGuard permission="system:org:manage">
            <Button type="link" size="small" icon={<EditOutlined />}
              style={{ marginLeft: 4, padding: '0 4px', height: 'auto', fontSize: 12 }}
              onClick={(e) => openLeaderModal(e, 'group', g.id, g.name, g.leader?.id)}>
              设置负责人
            </Button>
          </PermissionGuard>
        </span>
      ),
      children: [
        ...(g.members?.length ? [{
          key: `members-${g.id}`,
          title: (
            <span style={{ color: '#7A7060', fontSize: 12 }}>
              <UserOutlined style={{ marginRight: 4 }} />
              {g.members.map((m: any) => (
                <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8, marginBottom: 2 }}>
                  <Tag style={{ fontSize: 11, marginRight: 2, marginBottom: 0 }}
                    color={g.leader?.id === m.id ? 'blue' : 'default'}>
                    {m.realName}{g.leader?.id === m.id ? '(负责人)' : ''}
                  </Tag>
                  {m.roles?.map((role: any) => (
                    <Tag key={role.id} color="orange" style={{ fontSize: 10, marginRight: 2, marginBottom: 0 }}>{role.label}</Tag>
                  ))}
                </span>
              ))}
            </span>
          ),
          selectable: false,
          isLeaf: true,
        }] : []),
        ...g.children?.length ? buildTreeData(g.children) : [],
      ],
    }));
  };

  const treeData = [
    ...departments
      .filter(dept => !selectedDeptId || dept.id === selectedDeptId)
      .map(dept => ({
        key: `dept-${dept.id}`,
        title: (
          <span>
            <ApartmentOutlined style={{ marginRight: 6 }} />
            <strong>{dept.name}</strong>
            {dept.leader && <Tag color="green" style={{ marginLeft: 8, fontSize: 12 }}>负责人: {dept.leader.realName}</Tag>}
            <PermissionGuard permission="system:org:manage">
              <Button type="link" size="small" icon={<EditOutlined />}
                style={{ marginLeft: 4, padding: '0 4px', height: 'auto', fontSize: 12 }}
                onClick={(e) => openLeaderModal(e, 'dept', dept.id, dept.name, dept.leader?.id)}>
                设置负责人
              </Button>
            </PermissionGuard>
          </span>
        ),
        children: buildTreeData(groupTree.filter((g: any) => g.departmentId === dept.id)),
      })),
  ];

  // 设置负责人弹窗的人选：按组/部门归属过滤
  const leaderOptions = leaderModal
    ? (leaderModal.type === 'group'
        ? allUsers.filter(u => u.groupId === leaderModal.id)
        : allUsers.filter(u => u.departmentId === leaderModal.id))
        .map(u => ({ label: `${u.realName}(${u.username})`, value: u.id }))
    : [];

  return (
    <div>
      <div style={{ marginBottom: 12, color: '#9A9080', fontSize: 12 }}>
        组织架构来自身份源（Authentik）同步；部门/组负责人可在此处设置（审批流程的「直属负责人/上级负责人/部门负责人」依赖此字段）。
      </div>
      <Row gutter={16}>
        <Col span={6}>
          <Card title="部门列表" size="small">
            {departments.map(d => (
              <div key={d.id} style={{
                padding: '8px 12px', cursor: 'pointer', borderRadius: 6, marginBottom: 4,
                background: selectedDeptId === d.id ? '#eef2ff' : 'transparent',
                fontWeight: selectedDeptId === d.id ? 600 : 400,
              }} onClick={() => setSelectedDeptId(selectedDeptId === d.id ? null : d.id)}>
                <ApartmentOutlined style={{ marginRight: 8 }} />
                {d.name}
                {d.leader && <Tag color="green" style={{ marginLeft: 8, fontSize: 11 }}>{d.leader.realName}</Tag>}
              </div>
            ))}
          </Card>
        </Col>
        <Col span={18}>
          <Card title={`组织架构 ${selectedDeptId ? `(${departments.find(d => d.id === selectedDeptId)?.name || ''})` : ''}`}
            size="small" extra={
              <Button size="small" icon={<ReloadOutlined />} onClick={load} />
            }>
            {treeData.length ? (
              <Tree treeData={treeData} defaultExpandAll blockNode />
            ) : (
              <Empty description="暂无组织架构" />
            )}
          </Card>
        </Col>
      </Row>

      <Modal title={leaderModal ? `设置「${leaderModal.name}」负责人` : ''}
        open={!!leaderModal} width={480} confirmLoading={saving}
        onCancel={() => { setLeaderModal(null); leaderForm.resetFields(); }}
        onOk={() => leaderForm.submit()}>
        <div style={{ marginBottom: 12, color: '#9A9080', fontSize: 12 }}>
          负责人将作为该{leaderModal?.type === 'group' ? '组' : '部门'}提交工时/加班/周报时的默认审批人。清空可移除负责人。
        </div>
        <Form form={leaderForm} layout="vertical" onFinish={handleLeaderSave}>
          <Form.Item name="leaderId" label="负责人">
            <Select allowClear showSearch optionFilterProp="label" placeholder="选择负责人（可清空）"
              options={leaderOptions}
              notFoundContent={leaderModal ? `该${leaderModal.type === 'group' ? '组' : '部门'}暂无成员，请先在用户管理中分配用户到此${leaderModal.type === 'group' ? '组' : '部门'}` : undefined} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ==================== 用户管理 ====================
function UserTab() {
  const [data, setData] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groupTreeData, setGroupTreeData] = useState<any[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<UserListItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    const [userRes, deptRes, groupRes, roleRes] = await Promise.all([
      systemApi.getUsers({ page, pageSize: 20 }),
      systemApi.getDepartments(),
      systemApi.getGroupTree(),
      systemApi.getRoles(),
    ]);
    if (userRes.data) { setData(userRes.data.list); setTotal(userRes.data.total); }
    if (deptRes.data) setDepartments(deptRes.data);
    if (groupRes.data) setGroupTreeData(groupRes.data);
    if (roleRes.data) setRoles(roleRes.data);
  };

  useEffect(() => { load(); }, [page]);

  // 构建分组 TreeSelect 数据：部门 > 分组(多级)
  const buildGroupNodes = (groups: any[]): any[] => {
    return groups.map(g => ({
      title: g.name + (g.leader ? ` (${g.leader.realName})` : ''),
      value: g.id,
      key: `group-${g.id}`,
      children: g.children?.length ? buildGroupNodes(g.children) : [],
    }));
  };

  const buildGroupSelectTree = (deptId?: number): any[] => {
    if (deptId) {
      // 已选部门：只展示该部门下的分组（平铺，不再嵌套部门层级）
      return buildGroupNodes(groupTreeData.filter((g: any) => g.departmentId === deptId));
    }
    // 未选部门：展示全部部门作为分组节点（保持原行为）
    return departments.map(dept => ({
      title: dept.name,
      value: `dept-${dept.id}`,
      key: `dept-${dept.id}`,
      disabled: true,
      selectable: false,
      children: buildGroupNodes(groupTreeData.filter((g: any) => g.departmentId === dept.id)),
    }));
  };

  // 监听部门选择，动态过滤分组下拉
  const watchedDeptId = Form.useWatch('departmentId', form);
  const groupSelectTreeData = buildGroupSelectTree(watchedDeptId);

  // 部门切换时清空已选分组（旧分组可能不属于新部门）
  useEffect(() => {
    if (!modalOpen) return;
    const currentGroupId = form.getFieldValue('groupId');
    if (currentGroupId == null) return;
    // 校验当前分组是否属于所选部门，不属于则清空
    const belongs = groupSelectTreeData.some(node => {
      const search = (nodes: any[]): boolean => nodes.some(n =>
        n.value === currentGroupId || (n.children?.length && search(n.children))
      );
      return search([node]);
    });
    if (!belongs) form.setFieldValue('groupId', undefined);
  }, [watchedDeptId]);

  const handleSave = async (values: any) => {
    if (editItem) {
      await systemApi.updateUser(editItem.id, values);
    } else {
      await systemApi.createUser(values);
    }
    message.success('操作成功');
    setModalOpen(false);
    setEditItem(null);
    form.resetFields();
    load();
  };

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username', width: 100 },
    { title: '姓名', dataIndex: 'realName', key: 'realName', width: 100 },
    { title: '邮箱', dataIndex: 'email', key: 'email', width: 160 },
    { title: '部门', key: 'dept', width: 100, render: (_: any, r: UserListItem) => r.department?.name || '-' },
    { title: '分组', key: 'group', width: 100, render: (_: any, r: UserListItem) => r.group?.name || '-' },
    { title: '角色', key: 'roles', width: 150, render: (_: any, r: UserListItem) => r.roles.map(role => <Tag key={role.id}>{role.label}</Tag>) },
    { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: (s: number) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? '启用' : '禁用'}</Tag> },
    {
      title: '操作', key: 'action', width: 200,
      render: (_: any, record: UserListItem) => (
        <Space>
          <Button type="link" size="small" onClick={() => {
            setEditItem(record);
            form.setFieldsValue({ ...record, departmentId: record.department?.id, groupId: record.group?.id, roleIds: record.roles.map(r => r.id) });
            setModalOpen(true);
          }}>编辑</Button>
          <Popconfirm title="确定重置密码为123456?" onConfirm={async () => { await systemApi.resetPassword(record.id, '123456'); message.success('密码已重置'); }}>
            <Button type="link" size="small">重置密码</Button>
          </Popconfirm>
          <Popconfirm title="确定删除?" onConfirm={async () => { await systemApi.deleteUser(record.id); message.success('删除成功'); load(); }}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
        onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true); }}>
        新增用户
      </Button>
      <Table rowKey="id" columns={columns} dataSource={data}
        pagination={{ current: page, total, pageSize: 20, onChange: setPage, showTotal: (t) => `共 ${t} 条` }} size="middle" />
      <Modal title={editItem ? '编辑用户' : '新增用户'} open={modalOpen} width={600} confirmLoading={saving}
        onCancel={() => { setModalOpen(false); setEditItem(null); }} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                <Input disabled={!!editItem} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="realName" label="姓名" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          {!editItem && (
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
          )}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="email" label="邮箱"><Input /></Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="手机号"><Input /></Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="departmentId" label="部门">
                <Select allowClear options={departments.map(d => ({ label: d.name, value: d.id }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="groupId" label="分组">
                <TreeSelect
                  allowClear
                  showSearch
                  treeNodeFilterProp="title"
                  placeholder="选择分组"
                  treeData={groupSelectTreeData}
                  treeDefaultExpandAll
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="roleIds" label="角色">
            <Select mode="multiple" options={roles.map(r => ({ label: r.label, value: r.id }))} />
          </Form.Item>
          {editItem && (
            <Form.Item name="status" label="状态" valuePropName="checked" getValueFromEvent={(v: boolean) => v ? 1 : 0} getValueProps={(v: number) => ({ checked: v === 1 })}>
              <Switch checkedChildren="启用" unCheckedChildren="禁用" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}

// ==================== 角色权限 ====================
function RoleTab() {
  const { hasPermission } = usePermission();
  const canUpdate = hasPermission('system:role:manage');
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [selectedRole, setSelectedRole] = useState<number>();
  const [checkedKeys, setCheckedKeys] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [roleModal, setRoleModal] = useState<{ mode: 'create' | 'copy' | 'edit'; role?: Role } | null>(null);
  const [roleForm] = Form.useForm();

  const load = async (preferredRoleId?: number) => {
    setLoading(true);
    try {
      const [roleRes, permRes] = await Promise.all([systemApi.getRoles(), systemApi.getPermissions()]);
      const nextRoles = roleRes.data || [];
      const nextPermissions = permRes.data || [];
      setRoles(nextRoles);
      setPermissions(nextPermissions);
      const targetRoleId = preferredRoleId ?? selectedRole;
      const nextSelected = nextRoles.find(role => role.id === targetRoleId) || nextRoles[0];
      setSelectedRole(nextSelected?.id);
      setCheckedKeys(nextSelected?.name === 'admin'
        ? nextPermissions.map(permission => permission.id)
        : nextSelected?.permissions.map(permission => permission.id) || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleRoleSelect = (roleId: number) => {
    setSelectedRole(roleId);
    const role = roles.find(r => r.id === roleId);
    setCheckedKeys(role?.name === 'admin'
      ? permissions.map(permission => permission.id)
      : role?.permissions.map(permission => permission.id) || []);
  };

  const handleSave = async () => {
    if (!selectedRole) return message.warning('请选择角色');
    setSaving(true);
    try {
      await systemApi.updateRolePermissions(selectedRole, checkedKeys);
      message.success('角色权限已更新，关联用户将在下次请求时生效');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const moduleLabels: Record<string, string> = {
    timesheet: '工时管理',
    overtime: '加班管理',
    weekly_report: '周报管理',
    approval: '审批中心',
    report: '报表中心',
    project: '项目管理',
    system: '系统管理',
    permission_request: '权限申请',
    permission_grant: '权限授权',
  };

  const currentRole = roles.find(role => role.id === selectedRole);
  const isAdminRole = currentRole?.name === 'admin';
  const visiblePermissions = permissions.filter(permission => {
    const query = keyword.trim().toLowerCase();
    if (!query) return true;
    return [permission.name, permission.code, permission.description]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(query));
  });
  const modules = Array.from(new Set(permissions.map(permission => permission.module)));

  const openRoleModal = (mode: 'create' | 'copy' | 'edit', role?: Role) => {
    setRoleModal({ mode, role });
    roleForm.resetFields();
    if (mode === 'edit' && role) {
      roleForm.setFieldsValue({ label: role.label, description: role.description });
    } else {
      roleForm.setFieldsValue({
        label: mode === 'copy' && role ? `${role.label}副本` : undefined,
        templateRoleId: role?.id,
      });
    }
  };

  const saveRole = async (values: any) => {
    setSaving(true);
    try {
      let preferredRoleId: number | undefined;
      if (roleModal?.mode === 'edit' && roleModal.role) {
        await systemApi.updateRole(roleModal.role.id, {
          label: values.label,
          description: values.description || '',
        });
        message.success('角色信息已更新');
      } else {
        const template = roles.find(role => role.id === values.templateRoleId);
        const res = await systemApi.createRole({
          name: values.name,
          label: values.label,
          description: values.description,
          permissionIds: template?.permissions.map(permission => permission.id) || [],
        });
        preferredRoleId = res.data?.id;
        message.success(template ? '角色已创建，并复制模板权限' : '角色已创建');
      }
      setRoleModal(null);
      roleForm.resetFields();
      await load(preferredRoleId);
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async (role: Role) => {
    await systemApi.deleteRole(role.id);
    message.success('角色已删除');
    if (selectedRole === role.id) setSelectedRole(undefined);
    await load();
  };

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="角色用于长期授权，范围由用户的组织职责决定"
        description="例如角色中的“查看所负责部门工时”只覆盖该用户担任负责人的部门；需要临时查看指定部门时，请走权限申请。系统不会允许创建没有实际控制点的权限。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card
            title={<Space><SafetyCertificateOutlined />角色</Space>}
            size="small"
            loading={loading}
            extra={canUpdate && <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => openRoleModal('create')}>新建</Button>}
          >
            {roles.length === 0 ? (
              <Empty description="暂无角色" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : roles.map(role => (
              <div
                key={role.id}
                role="button"
                tabIndex={0}
                onClick={() => handleRoleSelect(role.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') handleRoleSelect(role.id); }}
                style={{
                  padding: '11px 12px',
                  cursor: 'pointer',
                  borderRadius: 10,
                  marginBottom: 6,
                  border: selectedRole === role.id ? '1px solid #A9BDAA' : '1px solid transparent',
                  background: selectedRole === role.id ? '#F0F5EF' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <Space size={6} style={{ minWidth: 0 }}>
                    <Text strong={selectedRole === role.id} ellipsis>{role.label}</Text>
                    {role.isSystem && <Tag icon={<LockOutlined />} color="default">内置</Tag>}
                  </Space>
                  {canUpdate && (
                    <Space size={0} onClick={(event) => event.stopPropagation()}>
                      <Tooltip title="复制为自定义角色">
                        <Button aria-label={`复制角色${role.label}`} type="text" size="small" icon={<CopyOutlined />} onClick={() => openRoleModal('copy', role)} />
                      </Tooltip>
                      {!role.isSystem && (
                        <>
                          <Tooltip title="编辑角色信息">
                            <Button aria-label={`编辑角色${role.label}`} type="text" size="small" icon={<EditOutlined />} onClick={() => openRoleModal('edit', role)} />
                          </Tooltip>
                          <Popconfirm
                            title={`删除角色“${role.label}”？`}
                            description={role.userCount ? `该角色仍分配给 ${role.userCount} 名用户，无法删除。` : '删除后不可恢复。'}
                            okText="删除角色"
                            cancelText="取消"
                            okButtonProps={{ danger: true, disabled: !!role.userCount }}
                            onConfirm={() => deleteRole(role)}
                          >
                            <Button aria-label={`删除角色${role.label}`} type="text" size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </>
                      )}
                    </Space>
                  )}
                </div>
                <div style={{ marginTop: 4, color: '#8A8175', fontSize: 12 }}>
                  {role.name} · {role.userCount || 0} 名用户 · {role.permissions.length} 项权限
                </div>
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card
            title={currentRole ? `${currentRole.label}的权限` : '权限配置'}
            size="small"
            loading={loading}
            extra={(
              <Space>
                <Text type="secondary">已选 {checkedKeys.length} 项</Text>
                <PermissionGuard permission="system:role:manage">
                  <Button type="primary" size="small" onClick={handleSave} loading={saving} disabled={!currentRole || isAdminRole}>
                    保存权限
                  </Button>
                </PermissionGuard>
              </Space>
            )}
          >
            {isAdminRole && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message="管理员角色始终拥有全部权限"
                description="超级管理员由角色标识直接判定，修改勾选项不会改变实际权限，因此这里保持只读。"
              />
            )}
            <Input
              allowClear
              prefix={<SearchOutlined />}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索权限名称、权限码或作用说明"
              style={{ marginBottom: 18 }}
            />
            {!currentRole ? (
              <Empty description="请先选择一个角色" />
            ) : modules.map(module => {
              const modulePermissions = visiblePermissions.filter(permission => permission.module === module);
              if (!modulePermissions.length) return null;
              const moduleIds = modulePermissions.map(permission => permission.id);
              const allChecked = moduleIds.every(id => checkedKeys.includes(id));
              return (
                <section key={module} style={{ marginBottom: 22 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <Text strong>{moduleLabels[module] || module}</Text>
                    {!isAdminRole && canUpdate && (
                      <Button type="link" size="small" onClick={() => setCheckedKeys(current => (
                        allChecked
                          ? current.filter(id => !moduleIds.includes(id))
                          : Array.from(new Set([...current, ...moduleIds]))
                      ))}>
                        {allChecked ? '取消本组' : '选择本组'}
                      </Button>
                    )}
                  </div>
                  <Row gutter={[10, 10]}>
                    {modulePermissions.map(permission => (
                      <Col xs={24} md={12} key={permission.id}>
                        <label style={{
                          display: 'flex',
                          gap: 10,
                          alignItems: 'flex-start',
                          padding: '11px 12px',
                          minHeight: 78,
                          borderRadius: 10,
                          border: checkedKeys.includes(permission.id) ? '1px solid #A9BDAA' : '1px solid #E8E1D7',
                          background: checkedKeys.includes(permission.id) ? '#F4F7F2' : '#FDFBF7',
                          cursor: !canUpdate || isAdminRole ? 'not-allowed' : 'pointer',
                        }}>
                          <Checkbox
                            checked={checkedKeys.includes(permission.id)}
                            disabled={!canUpdate || isAdminRole}
                            onChange={(event) => setCheckedKeys(current => (
                              event.target.checked
                                ? [...current, permission.id]
                                : current.filter(id => id !== permission.id)
                            ))}
                          />
                          <span style={{ minWidth: 0 }}>
                            <Text style={{ display: 'block' }}>{permission.name}</Text>
                            <Text type="secondary" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
                              {permission.description || permission.code}
                            </Text>
                            {permission.description && (
                              <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}>
                                {permission.code}
                              </Text>
                            )}
                          </span>
                        </label>
                      </Col>
                    ))}
                  </Row>
                </section>
              );
            })}
          </Card>
        </Col>
      </Row>

      <Modal
        title={roleModal?.mode === 'edit' ? '编辑自定义角色' : roleModal?.mode === 'copy' ? '复制角色' : '新建自定义角色'}
        open={!!roleModal}
        onCancel={() => setRoleModal(null)}
        onOk={() => roleForm.submit()}
        confirmLoading={saving}
        okText={roleModal?.mode === 'edit' ? '保存角色信息' : '创建角色'}
        destroyOnHidden
      >
        <Form form={roleForm} layout="vertical" onFinish={saveRole}>
          {roleModal?.mode !== 'edit' && (
            <Form.Item
              name="name"
              label="角色标识"
              extra="创建后不可修改；用于系统内部识别，例如 finance_reviewer。"
              rules={[
                { required: true, message: '请输入角色标识' },
                { pattern: /^[a-z][a-z0-9_]*$/, message: '仅支持小写字母、数字和下划线，且必须以字母开头' },
              ]}
            >
              <Input maxLength={50} placeholder="例如 finance_reviewer" />
            </Form.Item>
          )}
          <Form.Item name="label" label="角色名称" rules={[{ required: true, message: '请输入角色名称' }]}>
            <Input maxLength={50} placeholder="例如 财务复核员" />
          </Form.Item>
          <Form.Item name="description" label="职责说明">
            <Input.TextArea rows={3} maxLength={255} showCount placeholder="说明该角色适用于哪些人员和职责" />
          </Form.Item>
          {roleModal?.mode !== 'edit' && (
            <Form.Item name="templateRoleId" label="权限模板（可选）" extra="只复制当前可分配的权限，不会复制用户。">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={roles.map(role => ({ label: `${role.label}（${role.permissions.length} 项）`, value: role.id }))}
                placeholder="从现有角色复制权限"
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}

// ==================== 项目管理（含PM/SPM/SE） ====================
function ProjectTab() {
  const [data, setData] = useState<any[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [seModalOpen, setSeModalOpen] = useState(false);
  const [allocationModalOpen, setAllocationModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<any | null>(null);
  const [selectedProject, setSelectedProject] = useState<any>(null);
  const [projectSEs, setProjectSEs] = useState<ProjectSE[]>([]);
  const [projectAllocations, setProjectAllocations] = useState<ProjectWorkloadAllocation[]>([]);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [seForm] = Form.useForm();
  const [allocationForm] = Form.useForm();

  const load = async () => {
    const [projRes, userRes, groupRes] = await Promise.all([
      systemApi.getProjects(),
      systemApi.getAllUsers(),
      systemApi.getGroups(),
    ]);
    if (projRes.data) setData(projRes.data);
    if (userRes.data) setUsers(userRes.data);
    if (groupRes.data) setGroups(groupRes.data);
  };

  useEffect(() => { load(); }, []);

  const loadProjectSEs = async (projectId: number) => {
    const res = await systemApi.getProjectSEs(projectId);
    if (res.data) setProjectSEs(res.data);
  };

  const handleSave = async (values: any) => {
    if (editItem) {
      await systemApi.updateProject(editItem.id, values);
    } else {
      await systemApi.createProject(values);
    }
    message.success('操作成功');
    setModalOpen(false);
    form.resetFields();
    setEditItem(null);
    load();
  };

  const handleAddSE = async (values: any) => {
    if (!selectedProject) return;
    await systemApi.addProjectSE(selectedProject.id, values);
    message.success('添加成功');
    seForm.resetFields();
    loadProjectSEs(selectedProject.id);
    load();
  };

  const loadProjectAllocations = async (projectId: number) => {
    const res = await systemApi.getProjectAllocations(projectId);
    if (res.data) setProjectAllocations(res.data);
  };

  const handleAddAllocation = async (values: any) => {
    if (!selectedProject) return;
    await systemApi.addProjectAllocation(selectedProject.id, values);
    message.success('保存成功');
    allocationForm.resetFields();
    loadProjectAllocations(selectedProject.id);
    load();
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '项目名称', dataIndex: 'name' },
    { title: '项目编码', dataIndex: 'code' },
    {
      title: '项目管理员', key: 'managers', width: 180, render: (_: any, r: any) => {
        const managers = r.managers || [];
        return managers.length
          ? managers.map((m: any) => <Tag key={m.id} color="blue">{m.realName}</Tag>)
          : <Tag>未指定</Tag>;
      },
    },
    { title: '模块SE', key: 'se', width: 200, render: (_: any, r: any) => {
      const ses = r.moduleSEs || [];
      return ses.length ? ses.map((se: any) => (
        <Tag key={se.id} color="purple">{se.user?.realName} → {se.group?.name}</Tag>
      )) : <Tag>未配置</Tag>;
    }},
    { title: '工时配额', key: 'allocations', width: 200, render: (_: any, r: any) => {
      const allocs = r.workloadAllocations || [];
      return allocs.length ? allocs.map((a: any) => (
        <Tag key={a.id} color="cyan">{a.groupName}: {a.allocation}天</Tag>
      )) : <Tag>未配置</Tag>;
    }},
    { title: '状态', dataIndex: 'status', width: 80, render: (s: number) => <Tag color={s === 1 ? 'green' : 'default'}>{s === 1 ? '进行中' : '已结束'}</Tag> },
    {
      title: '操作', key: 'action', width: 340,
      render: (_: any, record: any) => (
        <Space>
          <PermissionGuard permission="project:update">
            <Button type="link" size="small" onClick={() => {
              setEditItem(record);
              form.setFieldsValue({
                ...record,
                managerIds: (record.managers || []).map((m: any) => m.id),
              });
              setModalOpen(true);
            }}>编辑</Button>
            <Button type="link" size="small" onClick={() => {
              setSelectedProject(record);
              loadProjectSEs(record.id);
              seForm.resetFields();
              setSeModalOpen(true);
            }}>配置SE</Button>
            <Button type="link" size="small" onClick={() => {
              setSelectedProject(record);
              loadProjectAllocations(record.id);
              allocationForm.resetFields();
              setAllocationModalOpen(true);
            }}>配置工时</Button>
          </PermissionGuard>
          <PermissionGuard permission="project:delete">
            <Popconfirm title="确定删除?" onConfirm={async () => { await systemApi.deleteProject(record.id); message.success('删除成功'); load(); }}>
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
          </PermissionGuard>
        </Space>
      ),
    },
  ];

  const seColumns = [
    { title: 'SE', key: 'user', render: (_: any, r: ProjectSE) => r.user?.realName || '-' },
    { title: '负责组', key: 'group', render: (_: any, r: ProjectSE) => r.group?.name || '-' },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: any, r: ProjectSE) => (
        <PermissionGuard permission="project:assign_se">
          <Popconfirm title="确定删除?" onConfirm={async () => {
            await systemApi.removeProjectSE(r.id);
            message.success('删除成功');
            if (selectedProject) loadProjectSEs(selectedProject.id);
            load();
          }}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </PermissionGuard>
      ),
    },
  ];

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
        onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true); }}>
        新增项目
      </Button>
      <Table rowKey="id" columns={columns} dataSource={data} pagination={{ pageSize: 10 }} size="middle" />

      {/* 项目编辑 Modal */}
      <Modal title={editItem ? '编辑项目' : '新增项目'} open={modalOpen} confirmLoading={saving}
        onCancel={() => { setModalOpen(false); setEditItem(null); }} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="code" label="项目编码" rules={[{ required: true }]}>
            <Input disabled={!!editItem} placeholder="如: PROJ-001" />
          </Form.Item>
          <Form.Item name="managerIds" label="项目管理员" rules={[{ required: true, message: '请选择至少一个项目管理员' }]}>
            <Select mode="multiple" allowClear showSearch optionFilterProp="label"
              options={users.map(u => ({ label: u.realName, value: u.id }))} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* SE 配置 Modal */}
      <Modal title={`配置模块SE - ${selectedProject?.name || ''}`} open={seModalOpen}
        onCancel={() => { setSeModalOpen(false); setSelectedProject(null); }} footer={null} width={600}>
        <Card size="small" title="已有SE" style={{ marginBottom: 16 }}>
          <Table rowKey="id" columns={seColumns} dataSource={projectSEs} pagination={{ pageSize: 10 }} size="small"
            locale={{ emptyText: '暂无SE配置' }} />
        </Card>
        <PermissionGuard permission="project:update">
          <Card size="small" title="添加SE">
          <Form form={seForm} layout="inline" onFinish={handleAddSE}>
            <Form.Item name="userId" label="SE" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                options={users.map(u => ({ label: u.realName, value: u.id }))} />
            </Form.Item>
            <Form.Item name="groupId" label="负责组" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                options={groups.map(g => ({ label: g.name, value: g.id }))} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit">添加</Button>
            </Form.Item>
          </Form>
          </Card>
        </PermissionGuard>
      </Modal>

      {/* 工时配额 Modal */}
      <Modal title={`配置工时配额 - ${selectedProject?.name || ''}`} open={allocationModalOpen}
        onCancel={() => { setAllocationModalOpen(false); setSelectedProject(null); }} footer={null} width={600}>
        <div style={{ marginBottom: 12, color: '#9A9080', fontSize: 12 }}>
          按组配置工时配额（单位：人/天）。用户提交工时后，审批单中会动态展示该组在本项目的配额消耗，超额时向审批人警告。未配置的组不限制。
        </div>
        <Card size="small" title="已有配额" style={{ marginBottom: 16 }}>
          <Table rowKey="id" dataSource={projectAllocations} pagination={{ pageSize: 10 }} size="small"
            locale={{ emptyText: '暂无配额配置' }}
            columns={[
              { title: '组', key: 'groupName', dataIndex: 'groupName' },
              { title: '配额(人/天)', key: 'allocation', dataIndex: 'allocation', width: 120 },
              {
                title: '操作', key: 'action', width: 80,
                render: (_: any, r: ProjectWorkloadAllocation) => (
                  <Popconfirm title="确定删除?" onConfirm={async () => {
                    await systemApi.removeProjectAllocation(r.id);
                    message.success('删除成功');
                    if (selectedProject) loadProjectAllocations(selectedProject.id);
                    load();
                  }}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
        <Card size="small" title="添加/更新配额">
          <Form form={allocationForm} layout="inline" onFinish={handleAddAllocation}>
            <Form.Item name="groupId" label="组" rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" style={{ width: 180 }}
                placeholder="选择组"
                options={groups.map(g => ({ label: g.name, value: g.id }))} />
            </Form.Item>
            <Form.Item name="allocation" label="配额(人/天)" rules={[{ required: true, message: '请输入配额' }]}>
              <InputNumber min={0} step={0.5} style={{ width: 130 }} placeholder="如 20" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit">保存</Button>
            </Form.Item>
          </Form>
          <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>
            同一项目同一组重复保存会覆盖原配额值。
          </div>
        </Card>
      </Modal>
    </>
  );
}

// ==================== 审批流程配置 ====================
function ApprovalFlowTab() {
  const [flows, setFlows] = useState<ApprovalFlow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editFlow, setEditFlow] = useState<ApprovalFlow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [users, setUsers] = useState<SimpleUser[]>([]);

  const load = async () => {
    const [flowRes, userRes] = await Promise.all([systemApi.getApprovalFlows(), systemApi.getAllUsers()]);
    if (flowRes.data) setFlows(flowRes.data);
    if (userRes.data) setUsers(userRes.data);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async (values: any) => {
    const data = {
      name: values.name,
      type: values.type,
      description: values.description,
      isDefault: values.isDefault,
      steps: (values.steps || []).map((s: any, i: number) => ({
        stepType: s.stepType,
        label: s.label || stepTypeMap[s.stepType] || `步骤${i + 1}`,
        parentLevel: s.parentLevel || 1,
        customApproverId: s.stepType === 'custom' ? s.customApproverId : null,
      })),
    };
    if (editFlow) {
      await systemApi.updateApprovalFlow(editFlow.id, data);
    } else {
      await systemApi.createApprovalFlow(data);
    }
    message.success('操作成功');
    setModalOpen(false);
    setEditFlow(null);
    form.resetFields();
    load();
  };

  const typeLabels: Record<string, string> = {
    timesheet: '工时审批', overtime: '加班审批', weekly_report: '周报审批', permission_request: '权限申请审批',
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '流程名称', dataIndex: 'name' },
    { title: '类型', dataIndex: 'type', width: 100, render: (t: string) => typeLabels[t] || t },
    { title: '默认', dataIndex: 'isDefault', width: 60, render: (v: boolean) => v ? <Tag color="green">是</Tag> : '-' },
    { title: '启用', dataIndex: 'enabled', width: 60, render: (v: boolean) => v ? <Tag color="blue">启用</Tag> : <Tag>禁用</Tag> },
    {
      title: '审批步骤', key: 'steps', render: (_: any, r: ApprovalFlow) => (
        <Space direction="vertical" size={2}>
          {(r.steps || []).sort((a, b) => a.stepOrder - b.stepOrder).map((s, i) => (
            <div key={i}>
              <Text type="secondary">{i + 1}.</Text> {s.label}
              <Tag color="geekblue" style={{ marginLeft: 4, fontSize: 11 }}>{stepTypeMap[s.stepType]}</Tag>
              {s.stepType === 'custom' && s.customApproverId && (
                <Tag style={{ fontSize: 11 }}>用户ID:{s.customApproverId}</Tag>
              )}
            </div>
          ))}
        </Space>
      ),
    },
    {
      title: '操作', key: 'action', width: 180,
      render: (_: any, record: ApprovalFlow) => (
        <Space>
          <PermissionGuard permission="system:approval_flow:manage">
            <Button type="link" size="small" onClick={() => {
              setEditFlow(record);
              form.setFieldsValue({
                name: record.name, type: record.type, description: record.description,
                isDefault: record.isDefault,
                steps: (record.steps || []).sort((a, b) => a.stepOrder - b.stepOrder).map(s => ({
                  stepType: s.stepType, label: s.label, parentLevel: s.parentLevel, customApproverId: s.customApproverId,
                })),
              });
              setModalOpen(true);
            }}>编辑</Button>
          </PermissionGuard>
          <PermissionGuard permission="system:approval_flow:manage">
            <Popconfirm title="确定删除?" onConfirm={async () => {
              await systemApi.deleteApprovalFlow(record.id);
              message.success('删除成功');
              load();
            }}>
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
          </PermissionGuard>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
        onClick={() => {
          setEditFlow(null);
          form.resetFields();
          form.setFieldsValue({ steps: [{ stepType: 'group_leader', label: '直属负责人审批' }] });
          setModalOpen(true);
        }}>
        新增审批流程
      </Button>
      <Table rowKey="id" columns={columns} dataSource={flows} pagination={{ pageSize: 10 }} size="middle" />

      <Modal title={editFlow ? '编辑审批流程' : '新增审批流程'} open={modalOpen} width={700} confirmLoading={saving}
        onCancel={() => { setModalOpen(false); setEditFlow(null); }} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="流程名称" rules={[{ required: true }]}>
                <Input placeholder="如：工时审批流程" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="type" label="适用类型" rules={[{ required: true }]}>
                <Select options={Object.entries(typeLabels).map(([k, v]) => ({ label: v, value: k }))} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="isDefault" label="设为该类型默认流程" valuePropName="checked">
            <Switch />
          </Form.Item>

          <div style={{ marginBottom: 16, fontWeight: 600 }}>审批步骤（按顺序）</div>
          <Form.List name="steps">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Card key={key} size="small" style={{ marginBottom: 8 }}
                    extra={<Button type="text" danger size="small" onClick={() => remove(name)}>删除</Button>}>
                    <Row gutter={8}>
                      <Col span={6}>
                        <Form.Item {...rest} name={[name, 'stepType']} label="步骤类型" rules={[{ required: true }]}>
                          <Select options={Object.entries(stepTypeMap).map(([k, v]) => ({ label: v, value: k }))} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item {...rest} name={[name, 'label']} label="显示名称">
                          <Input placeholder="如：直属负责人审批" />
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item {...rest} name={[name, 'parentLevel']} label="上级层级">
                          <InputNumber min={1} max={10} placeholder="1" style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item noStyle shouldUpdate={(prev, cur) =>
                          prev?.steps?.[name]?.stepType !== cur?.steps?.[name]?.stepType
                        }>
                          {({ getFieldValue }) => {
                            const stepType = getFieldValue(['steps', name, 'stepType']);
                            if (stepType === 'custom') {
                              return (
                                <Form.Item {...rest} name={[name, 'customApproverId']} label="审批人" rules={[{ required: true }]}>
                                  <Select showSearch optionFilterProp="label"
                                    options={users.map(u => ({ label: u.realName, value: u.id }))} />
                                </Form.Item>
                              );
                            }
                            return <div style={{ height: 56 }} />;
                          }}
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button type="dashed" block onClick={() => add({ stepType: 'group_leader', label: '', parentLevel: 1 })}>
                  + 添加审批步骤
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </>
  );
}

// ==================== 审计日志 ====================
function AuditTab() {
  const [data, setData] = useState<AuditLogItem[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [detailItem, setDetailItem] = useState<AuditLogItem | null>(null);
  const [form] = Form.useForm();

  const actionLabels: Record<string, string> = {
    login: '登录',
    logout: '退出登录',
    change_password: '修改密码',
    approve: '审批',
    reject: '驳回',
    'user.create': '创建用户',
    'user.update': '更新用户',
    'user.delete': '删除用户',
    'user.reset_password': '重置密码',
    'role.create': '创建角色',
    'role.update': '更新角色',
    'role.delete': '删除角色',
    'role.update_permissions': '更新角色权限',
  };

  const targetLabels: Record<string, string> = {
    system: '系统',
    user: '用户',
    role: '角色',
    timesheet: '工时',
    overtime: '加班',
    weekly_report: '周报',
    permission_request: '权限申请',
    pat: '访问令牌',
  };

  const load = async (targetPage = page) => {
    setLoading(true);
    try {
      const values = form.getFieldsValue();
      const dateRange = values.dateRange;
      const res = await auditApi.getList({
        page: targetPage,
        pageSize: 20,
        userId: values.userId,
        action: values.action?.trim() || undefined,
        target: values.target?.trim() || undefined,
        startDate: dateRange?.[0]?.startOf('day').toISOString(),
        endDate: dateRange?.[1]?.endOf('day').toISOString(),
      });
      if (res.data) {
        setData(res.data.list);
        setTotal(res.data.total);
        setPage(targetPage);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || '审计日志加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(1);
    systemApi.getAllUsers()
      .then((res) => setUsers(res.data || []))
      .catch(() => setUsers([]));
  }, []);

  const formatDetail = (detail: string | null) => {
    if (!detail) return '无附加详情';
    try {
      return JSON.stringify(JSON.parse(detail), null, 2);
    } catch {
      return detail;
    }
  };

  const columns = [
    {
      title: '时间', dataIndex: 'createdAt', width: 170,
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: '操作人', key: 'user', width: 140,
      render: (_: unknown, record: AuditLogItem) => record.userName || (record.userId ? `用户 #${record.userId}` : '系统'),
    },
    {
      title: '动作', dataIndex: 'action', width: 150,
      render: (value: string) => <Tag color="blue">{actionLabels[value] || value}</Tag>,
    },
    {
      title: '对象', key: 'target', width: 150,
      render: (_: unknown, record: AuditLogItem) => (
        <span>{targetLabels[record.target] || record.target}{record.targetId ? ` #${record.targetId}` : ''}</span>
      ),
    },
    { title: 'IP 地址', dataIndex: 'ip', width: 145, render: (value: string | null) => value || '-' },
    {
      title: '详情', key: 'detail',
      render: (_: unknown, record: AuditLogItem) => record.detail ? (
        <Button type="link" size="small" onClick={() => setDetailItem(record)}>查看详情</Button>
      ) : <Text type="secondary">-</Text>,
    },
  ];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="审计日志用于追踪关键管理操作"
        description="日志仅供查询，不支持编辑或删除。筛选条件为空时按时间倒序显示全部记录。"
      />
      <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 10 }} onFinish={() => load(1)}>
        <Form.Item name="userId" label="操作人">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部人员"
            style={{ width: 180 }}
            options={users.map(user => ({ label: `${user.realName}（${user.username}）`, value: user.id }))}
          />
        </Form.Item>
        <Form.Item name="action" label="动作">
          <Input allowClear placeholder="如 role.update" style={{ width: 160 }} />
        </Form.Item>
        <Form.Item name="target" label="对象">
          <Input allowClear placeholder="如 role" style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="dateRange" label="时间范围">
          <DatePicker.RangePicker allowClear style={{ width: 250 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>查询</Button>
            <Button onClick={() => { form.resetFields(); void load(1); }}>重置</Button>
          </Space>
        </Form.Item>
      </Form>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={data}
        size="middle"
        scroll={{ x: 900 }}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          showTotal: count => `共 ${count} 条`,
          onChange: nextPage => load(nextPage),
        }}
      />

      <Modal
        title={detailItem ? `审计详情 #${detailItem.id}` : '审计详情'}
        open={!!detailItem}
        footer={<Button onClick={() => setDetailItem(null)}>关闭</Button>}
        onCancel={() => setDetailItem(null)}
        width={680}
      >
        {detailItem && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="操作人">{detailItem.userName || '系统'}</Descriptions.Item>
              <Descriptions.Item label="时间">{new Date(detailItem.createdAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="动作">{actionLabels[detailItem.action] || detailItem.action}</Descriptions.Item>
              <Descriptions.Item label="对象">{targetLabels[detailItem.target] || detailItem.target}</Descriptions.Item>
              <Descriptions.Item label="对象 ID">{detailItem.targetId || '-'}</Descriptions.Item>
              <Descriptions.Item label="IP 地址">{detailItem.ip || '-'}</Descriptions.Item>
            </Descriptions>
            <pre style={{
              margin: 0,
              padding: 14,
              maxHeight: 360,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              border: '1px solid #E8E0D4',
              borderRadius: 10,
              background: '#F8F4ED',
              color: '#2C2418',
              fontSize: 12,
              lineHeight: 1.6,
            }}>{formatDetail(detailItem.detail)}</pre>
          </>
        )}
      </Modal>
    </>
  );
}

// ==================== 公告管理 ====================
function AnnouncementTab() {
  const [data, setData] = useState<AnnouncementItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<AnnouncementItem | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<AnnouncementStats | null>(null);
  const [statsTitle, setStatsTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    const [res, deptRes, groupRes, userRes] = await Promise.all([
      announcementApi.getAdminList({ page, pageSize: 20 }),
      systemApi.getDepartments(),
      systemApi.getGroups(),
      systemApi.getAllUsers(),
    ]);
    if (res.data) { setData(res.data.list); setTotal(res.data.total); }
    if (deptRes.data) setDepartments(deptRes.data);
    if (groupRes.data) setGroups(groupRes.data);
    if (userRes.data) setUsers(userRes.data);
  };

  useEffect(() => { load(); }, [page]);

  const handleSave = async (values: any) => {
    setSaving(true);
    const payload = {
      title: values.title,
      content: values.content || null,
      type: values.type || 'info',
      targetScope: values.targetScope || 'all',
      targetDeptId: values.targetScope === 'department' ? values.targetDeptId : null,
      targetGroupId: values.targetScope === 'group' ? values.targetGroupId : null,
      targetUserIds: values.targetScope === 'user' ? values.targetUserIds : null,
    };

    try {
      let result;
      if (editItem) {
        result = await announcementApi.update(editItem.id, payload);
      } else {
        result = await announcementApi.create(payload);
      }
      if (editItem) {
        message.success('更新成功（编辑不会重复发送 TT）');
      } else if (result?.data?.ttStatus === 'sent') {
        message.success('公告已发布，并已发送 TT 通知');
      } else if (result?.data?.ttStatus === 'failed') {
        message.warning('公告已发布，但 TT 通知发送失败');
      } else if (result?.data?.ttStatus === 'disabled') {
        message.info('公告已发布；TT 通知通道尚未启用');
      } else {
        message.success('公告已发布；没有可用 SIAM 工号的接收人');
      }
      setModalOpen(false);
      setEditItem(null);
      form.resetFields();
      load();
    } finally {
      setSaving(false);
    }
  };

  const handleViewStats = async (item: AnnouncementItem) => {
    try {
      const res = await announcementApi.getStats(item.id);
      if (res.data) {
        setStats(res.data);
        setStatsTitle(item.title);
        setStatsOpen(true);
      }
    } catch {
      message.error('获取统计失败');
    }
  };

  const typeColor: Record<string, string> = { info: 'blue', important: 'orange', urgent: 'red' };
  const typeLabel: Record<string, string> = { info: '普通', important: '重要', urgent: '紧急' };
  const scopeLabel: Record<string, string> = { all: '全部用户', department: '指定部门', group: '指定分组', user: '指定用户' };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    {
      title: '类型', dataIndex: 'type', width: 80,
      render: (t: string) => <Tag color={typeColor[t]}>{typeLabel[t] || t}</Tag>,
    },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    {
      title: '内容', dataIndex: 'content', width: 200, ellipsis: true,
      render: (t: string) => t || '-',
    },
    {
      title: '发送范围', dataIndex: 'targetScope', width: 110,
      render: (s: string, r: AnnouncementItem) => {
        let detail = scopeLabel[s] || s;
        if (s === 'department' && r.targetDeptId) {
          const dept = departments.find(d => d.id === r.targetDeptId);
          detail = dept ? dept.name : `部门ID:${r.targetDeptId}`;
        }
        if (s === 'group' && r.targetGroupId) {
          const group = groups.find(g => g.id === r.targetGroupId);
          detail = group ? group.name : `分组ID:${r.targetGroupId}`;
        }
        return <Tag>{detail}</Tag>;
      },
    },
    { title: '发布人', dataIndex: 'createdByName', width: 90 },
    {
      title: '发布时间', dataIndex: 'createdAt', width: 160,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作', key: 'action', width: 220,
      render: (_: any, record: AnnouncementItem) => (
        <Space>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewStats(record)}>
            统计
          </Button>
          <PermissionGuard permission="system:announcement:update">
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => {
              setEditItem(record);
              form.setFieldsValue({
                title: record.title,
                content: record.content,
                type: record.type,
                targetScope: record.targetScope,
                targetDeptId: record.targetDeptId,
                targetGroupId: record.targetGroupId,
                targetUserIds: record.targetUserIds,
              });
              setModalOpen(true);
            }}>
              {'\u7f16\u8f91'}
            </Button>
          </PermissionGuard>
          <PermissionGuard permission="system:announcement:delete">
            <Popconfirm title={'\u786e\u5b9a\u5220\u9664?'} onConfirm={async () => {
              await announcementApi.delete(record.id);
              message.success('\u5220\u9664\u6210\u529f');
              load();
            }}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>{'\u5220\u9664'}</Button>
            </Popconfirm>
          </PermissionGuard>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PermissionGuard permission="system:announcement:create">
        <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
          onClick={() => {
            setEditItem(null);
            form.resetFields();
            form.setFieldsValue({ type: 'info', targetScope: 'all' });
            setModalOpen(true);
          }}>
          发布公告
        </Button>
      </PermissionGuard>
      <Table rowKey="id" columns={columns} dataSource={data}
        pagination={{ current: page, total, pageSize: 20, onChange: setPage, showTotal: (t) => `共 ${t} 条` }}
        size="middle" />

      {/* 发布/编辑公告 Modal */}
      <Modal title={editItem ? '编辑公告' : '发布公告'} open={modalOpen} width={640} confirmLoading={saving}
        onCancel={() => { setModalOpen(false); setEditItem(null); }}
        onOk={() => form.submit()} okText={editItem ? '保存' : '发布'}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入公告标题' }]}>
            <Input placeholder="请输入公告标题" maxLength={200} />
          </Form.Item>
          <Form.Item name="content" label="内容">
            <Input.TextArea rows={6} placeholder="请输入公告内容（支持换行）" showCount maxLength={2000} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="type" label="紧急程度">
                <Select options={[
                  { label: '普通通知', value: 'info' },
                  { label: '重要通知', value: 'important' },
                  { label: '紧急通知', value: 'urgent' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="targetScope" label="发送范围">
                <Select options={[
                  { label: '全部用户', value: 'all' },
                  { label: '指定部门', value: 'department' },
                  { label: '指定分组（含子分组）', value: 'group' },
                  { label: '指定用户', value: 'user' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev?.targetScope !== cur?.targetScope}>
            {({ getFieldValue }) => {
              const scope = getFieldValue('targetScope');
              if (scope === 'department') {
                return (
                  <Form.Item name="targetDeptId" label="选择部门" rules={[{ required: true, message: '请选择部门' }]}>
                    <Select showSearch optionFilterProp="label" placeholder="请选择部门"
                      options={departments.map(d => ({ label: d.name, value: d.id }))} />
                  </Form.Item>
                );
              }
              if (scope === 'group') {
                return (
                  <Form.Item name="targetGroupId" label="选择分组" rules={[{ required: true, message: '请选择分组' }]}>
                    <Select showSearch optionFilterProp="label" placeholder="请选择分组，范围包含其子分组"
                      options={groups.map(g => ({ label: g.name, value: g.id }))} />
                  </Form.Item>
                );
              }
              if (scope === 'user') {
                return (
                  <Form.Item name="targetUserIds" label="选择用户" rules={[{ required: true, message: '请选择用户' }]}>
                    <Select mode="multiple" showSearch optionFilterProp="label" placeholder="请选择用户"
                      options={users.map(u => ({ label: u.realName || u.username, value: u.id }))} />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
          {!editItem && (
            <Alert
              type="info"
              showIcon
              message="发布后将同步发送 TT"
              description="系统按公告范围解析启用用户，并使用其 OPPO SIAM 工号批量发送；未绑定 SIAM 工号的用户会跳过，站内公告不受影响。"
            />
          )}
        </Form>
      </Modal>

      {/* 已读统计 Modal */}
      <Modal title={`公告已读统计 - ${statsTitle}`} open={statsOpen}
        onCancel={() => setStatsOpen(false)} footer={null} width={600}>
        {stats && (
          <>
            <Row gutter={16} style={{ marginBottom: 20 }}>
              <Col span={6}>
                <Statistic title="目标用户" value={stats.targetCount} />
              </Col>
              <Col span={6}>
                <Statistic title="已读" value={stats.readCount} valueStyle={{ color: '#4A8B5E' }} />
              </Col>
              <Col span={6}>
                <Statistic title="未读" value={stats.unreadCount} valueStyle={{ color: '#C0564B' }} />
              </Col>
              <Col span={6}>
                <Statistic title="已读率" value={stats.readRate} suffix="%" />
              </Col>
            </Row>
            <Progress percent={stats.readRate} strokeColor="#4A8B5E" style={{ marginBottom: 20 }} />
            <Card size="small" title="已读用户列表" style={{ maxHeight: 300, overflow: 'auto' }}>
              {stats.readUsers.length === 0 ? (
                <Empty description="暂无已读记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <List size="small" dataSource={stats.readUsers}
                  renderItem={(u: any) => (
                    <List.Item>
                      <span>{u.realName}</span>
                      <span style={{ color: '#999', fontSize: 12 }}>{new Date(u.readAt).toLocaleString()}</span>
                    </List.Item>
                  )} />
              )}
            </Card>
          </>
        )}
      </Modal>
    </>
  );
}

// ==================== 系统设置 ====================
function SettingsTab() {
  // 工时填报单位（天步长），默认 0.5 天
  const [timesheetUnit, setTimesheetUnit] = useState<string>('0.5');
  const [lockDay, setLockDay] = useState<number>(0);
  const [localSystemName, setLocalSystemName] = useState<string>('WorkTime');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [reminderConfig, setReminderConfig] = useState<TimesheetReminderConfig>({
    enabled: false,
    weekdays: [5],
    time: '17:30',
    targetScope: 'all',
    message: '请及时填写并提交本周工时，谢谢。',
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { setSystemName } = useAppStore();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const [res, deptRes, groupRes, userRes] = await Promise.all([
        systemApi.getSettings(),
        systemApi.getDepartments(),
        systemApi.getGroups(),
        systemApi.getAllUsers(),
      ]);
      if (deptRes.data) setDepartments(deptRes.data);
      if (groupRes.data) setGroups(groupRes.data);
      if (userRes.data) setUsers(userRes.data);
      if (res.data?.settings?.timesheet_unit) {
        // 兼容老值 days/hours，统一归一为 0.5 天
        const raw = res.data.settings.timesheet_unit;
        const valid = ['0.1', '0.2', '0.25', '0.5'];
        setTimesheetUnit(valid.includes(raw) ? raw : '0.5');
      }
      if (res.data?.settings?.timesheet_lock_day) {
        setLockDay(parseInt(res.data.settings.timesheet_lock_day, 10) || 0);
      }
      if (res.data?.settings?.system_name) {
        setLocalSystemName(res.data.settings.system_name);
      }
      if (res.data?.settings?.timesheet_reminder_config) {
        try {
          setReminderConfig(JSON.parse(res.data.settings.timesheet_reminder_config));
        } catch {
          message.warning('已保存的工时提醒配置格式异常，请重新保存');
        }
      }
    } catch {}
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await systemApi.updateSetting('timesheet_unit', timesheetUnit);
      message.success('设置已保存');
    } catch {
      message.error('保存失败');
    }
    setSaving(false);
  };

  const saveReminderConfig = async () => {
    if (!reminderConfig.weekdays.length) {
      message.warning('请至少选择一个提醒日');
      return;
    }
    if (!reminderConfig.time) {
      message.warning('请选择提醒时间');
      return;
    }
    if (!reminderConfig.message.trim()) {
      message.warning('请输入提醒内容');
      return;
    }
    setSaving(true);
    try {
      await systemApi.updateSetting('timesheet_reminder_config', JSON.stringify(reminderConfig));
      message.success(reminderConfig.enabled ? '定时提醒已保存并启用' : '定时提醒已保存并停用');
    } catch {
      message.error('保存失败');
    }
    setSaving(false);
  };

  return (
    <div>
      <Card title="品牌设置" style={{ marginBottom: 16 }} loading={loading}>
        <Row align="middle" gutter={16}>
          <Col>
            <Text strong>系统名称：</Text>
          </Col>
          <Col>
            <Input
              style={{ width: 240 }}
              value={localSystemName}
              onChange={(e) => setLocalSystemName(e.target.value)}
              placeholder="如：WorkTime"
            />
          </Col>
          <PermissionGuard permission="system:settings:manage">
            <Col>
              <Button type="primary" onClick={async () => {
                setSaving(true);
                try {
                  await systemApi.updateSetting('system_name', localSystemName);
                  setSystemName(localSystemName);
                  message.success('保存成功');
                } catch { message.error('保存失败'); }
                setSaving(false);
              }} loading={saving}>
                保存
              </Button>
            </Col>
          </PermissionGuard>
        </Row>
        <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>
          设置后将显示在左上角和登录页的品牌位置
        </div>
      </Card>

      <Card title="工时设置" style={{ marginBottom: 16 }} loading={loading}>
        <Row align="middle" gutter={16}>
          <Col>
            <Text strong>工时填报单位：</Text>
          </Col>
          <Col>
            <Radio.Group
              value={timesheetUnit}
              onChange={(e) => setTimesheetUnit(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="0.1">0.1天</Radio.Button>
              <Radio.Button value="0.2">0.2天</Radio.Button>
              <Radio.Button value="0.25">0.25天</Radio.Button>
              <Radio.Button value="0.5">0.5天</Radio.Button>
            </Radio.Group>
          </Col>
          <Col>
            <Button type="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </Col>
        </Row>
        <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>
          工时按天填报，最小单位 {timesheetUnit} 天；每天最多填1天，提交时校验周合计不少于5天。
        </div>
      </Card>

      {/* 工时锁定设置 */}
      <Card title="工时锁定" size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col>
            <span>每月</span>
            <InputNumber
              min={1}
              max={28}
              style={{ width: 80, margin: '0 8px' }}
              value={lockDay}
              onChange={(v) => setLockDay(v || 0)}
            />
            <span>号后不允许提交上月工时</span>
          </Col>
          <PermissionGuard permission="system:settings:manage">
            <Col>
              <Button type="primary" onClick={async () => {
                setSaving(true);
                try {
                  await systemApi.updateSetting('timesheet_lock_day', String(lockDay || ''));
                  message.success('保存成功');
                } catch { message.error('保存失败'); }
                setSaving(false);
              }} loading={saving}>
                保存
              </Button>
            </Col>
          </PermissionGuard>
        </Row>
        <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>
          {lockDay ? `每月${lockDay}号之后，用户将无法提交上月的工时记录` : '未设置工时锁定，用户可以随时提交历史工时'}
        </div>
      </Card>

      <Card
        title="TT 工时填写提醒"
        style={{ marginBottom: 16 }}
        loading={loading}
        extra={(
          <Space>
            <Text type="secondary">{reminderConfig.enabled ? '已启用' : '已停用'}</Text>
            <Switch
              checked={reminderConfig.enabled}
              onChange={(enabled) => setReminderConfig(current => ({ ...current, enabled }))}
            />
          </Space>
        )}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          message="提醒仅通过 TT 发送，不新增站内消息"
          description="到点后按所选范围解析启用用户的 OPPO SIAM 工号并批量发送；没有 SIAM 工号的用户会自动跳过。执行时区固定为 Asia/Shanghai。"
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Text strong>提醒日</Text>
            <Select
              mode="multiple"
              style={{ width: '100%', marginTop: 8 }}
              value={reminderConfig.weekdays}
              onChange={(weekdays) => setReminderConfig(current => ({ ...current, weekdays }))}
              options={[
                { label: '周一', value: 1 },
                { label: '周二', value: 2 },
                { label: '周三', value: 3 },
                { label: '周四', value: 4 },
                { label: '周五', value: 5 },
                { label: '周六', value: 6 },
                { label: '周日', value: 7 },
              ]}
              placeholder="请选择提醒日"
            />
          </Col>
          <Col xs={24} lg={12}>
            <Text strong>提醒时间</Text>
            <Input
              type="time"
              style={{ marginTop: 8 }}
              value={reminderConfig.time}
              onChange={(event) => setReminderConfig(current => ({ ...current, time: event.target.value }))}
            />
          </Col>
          <Col xs={24} lg={12}>
            <Text strong>提醒范围</Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={reminderConfig.targetScope}
              onChange={(targetScope) => setReminderConfig(current => ({
                ...current,
                targetScope,
                targetDeptId: undefined,
                targetGroupId: undefined,
                targetUserIds: undefined,
              }))}
              options={[
                { label: '全部启用用户', value: 'all' },
                { label: '指定部门', value: 'department' },
                { label: '指定分组（含子分组）', value: 'group' },
                { label: '指定用户', value: 'user' },
              ]}
            />
          </Col>
          <Col xs={24} lg={12}>
            {reminderConfig.targetScope === 'department' && (
              <>
                <Text strong>部门</Text>
                <Select
                  showSearch
                  optionFilterProp="label"
                  style={{ width: '100%', marginTop: 8 }}
                  value={reminderConfig.targetDeptId}
                  onChange={(targetDeptId) => setReminderConfig(current => ({ ...current, targetDeptId }))}
                  options={departments.map(item => ({ label: item.name, value: item.id }))}
                  placeholder="请选择部门"
                />
              </>
            )}
            {reminderConfig.targetScope === 'group' && (
              <>
                <Text strong>分组</Text>
                <Select
                  showSearch
                  optionFilterProp="label"
                  style={{ width: '100%', marginTop: 8 }}
                  value={reminderConfig.targetGroupId}
                  onChange={(targetGroupId) => setReminderConfig(current => ({ ...current, targetGroupId }))}
                  options={groups.map(item => ({ label: item.name, value: item.id }))}
                  placeholder="请选择分组"
                />
              </>
            )}
            {reminderConfig.targetScope === 'user' && (
              <>
                <Text strong>用户</Text>
                <Select
                  mode="multiple"
                  showSearch
                  optionFilterProp="label"
                  style={{ width: '100%', marginTop: 8 }}
                  value={reminderConfig.targetUserIds}
                  onChange={(targetUserIds) => setReminderConfig(current => ({ ...current, targetUserIds }))}
                  options={users.map(item => ({ label: item.realName || item.username, value: item.id }))}
                  placeholder="请选择用户"
                />
              </>
            )}
            {reminderConfig.targetScope === 'all' && (
              <div style={{ marginTop: 28, color: '#6F675C' }}>将覆盖系统内全部启用用户</div>
            )}
          </Col>
          <Col span={24}>
            <Text strong>提醒内容</Text>
            <Input.TextArea
              rows={3}
              maxLength={1000}
              showCount
              style={{ marginTop: 8 }}
              value={reminderConfig.message}
              onChange={(event) => setReminderConfig(current => ({ ...current, message: event.target.value }))}
              placeholder="请输入 TT 提醒内容"
            />
          </Col>
        </Row>
        <div style={{ marginTop: 18, padding: '12px 14px', background: '#F8F4ED', borderRadius: 10, color: '#554B3E' }}>
          当前计划：{reminderConfig.enabled ? '启用' : '停用'}，每周
          {reminderConfig.weekdays.map(day => `周${'一二三四五六日'[day - 1]}`).join('、') || '未选择日期'}
          {' '}{reminderConfig.time || '--:--'} 执行。
        </div>
        <PermissionGuard permission="system:settings:manage">
          <Button type="primary" onClick={saveReminderConfig} loading={saving} style={{ marginTop: 16 }}>
            保存提醒设置
          </Button>
        </PermissionGuard>
      </Card>

      {/* OIDC 提供商由环境变量配置，无需在此开关；如需增减请编辑 server/.env 的 OIDC_PROVIDERS */}
    </div>
  );
}
