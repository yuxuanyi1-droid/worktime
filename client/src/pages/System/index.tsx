import { useEffect, useState, type ReactNode } from 'react';
import {
  Card, Tabs, Table, Button, Space, Modal, Form, Input, Select, Tag, message,
  Typography, Row, Col, Popconfirm, Switch, InputNumber, Tree, Tooltip, Empty, Radio,
  Progress, Descriptions, Statistic, Badge, List, TreeSelect,
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined,
  UserOutlined, ApartmentOutlined, TeamOutlined, SettingOutlined,
  NotificationOutlined, EyeOutlined, WarningOutlined, InfoCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { systemApi, UserListItem, SimpleUser } from '../../api/system';
import { Department, Group, Role, Permission, Project, ProjectSE, ProjectWorkloadAllocation, ApprovalFlow, ApprovalFlowStep, stepTypeMap } from '../../types';
import { announcementApi, AnnouncementItem, AnnouncementStats } from '../../api/notification';
import { useAppStore } from '../../stores/appStore';
import { usePermission } from '../../hooks/usePermission';

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
  { key: 'settings', label: '\u7cfb\u7edf\u8bbe\u7f6e', permission: 'system:settings:manage' },
];

export default function System() {
  const { hasPermission } = usePermission();
  const [tabKey, setTabKey] = useState('org');
  const tabItems = systemTabOptions.filter((item) => hasPermission(item.permission));

  useEffect(() => {
    if (tabItems.length && !tabItems.some((item) => item.key === tabKey)) {
      setTabKey(tabItems[0].key);
    }
  }, [tabKey, tabItems.map((item) => item.key).join(',')]);

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>{'\u7cfb\u7edf\u7ba1\u7406'}</Title>
      <Card style={{ borderRadius: 12 }}>
        {tabItems.length === 0 ? (
          <Empty description={'\u6682\u65e0\u53ef\u7ba1\u7406\u6a21\u5757'} />
        ) : (
          <Tabs activeKey={tabKey} onChange={setTabKey} items={tabItems.map(({ key, label }) => ({ key, label }))} />
        )}

        {tabKey === 'org' && <OrgTab />}
        {tabKey === 'user' && <UserTab />}
        {tabKey === 'role' && <RoleTab />}
        {tabKey === 'approval-flow' && <ApprovalFlowTab />}
        {tabKey === 'announcement' && <AnnouncementTab />}
        {tabKey === 'settings' && <SettingsTab />}
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

  const load = async () => {
    const [roleRes, permRes] = await Promise.all([systemApi.getRoles(), systemApi.getPermissions()]);
    if (roleRes.data) setRoles(roleRes.data);
    if (permRes.data) setPermissions(permRes.data);
  };

  useEffect(() => { load(); }, []);

  const handleRoleSelect = (roleId: number) => {
    setSelectedRole(roleId);
    const role = roles.find(r => r.id === roleId);
    setCheckedKeys(role?.permissions.map(p => p.id) || []);
  };

  const handleSave = async () => {
    if (!selectedRole) return message.warning('请选择角色');
    await systemApi.updateRolePermissions(selectedRole, checkedKeys);
    message.success('权限更新成功');
    load();
  };

  const moduleLabels: Record<string, string> = {
    timesheet: '工时管理', overtime: '加班管理', weekly_report: '周报管理', report: '报表中心', system: '系统管理',
  };

  return (
    <Row gutter={16}>
      <Col span={8}>
        <Card title="角色列表" size="small">
          {roles.map(role => (
            <div key={role.id} style={{
              padding: '8px 12px', cursor: 'pointer', borderRadius: 6, marginBottom: 4,
              background: selectedRole === role.id ? '#eef2ff' : 'transparent',
              fontWeight: selectedRole === role.id ? 600 : 400,
            }} onClick={() => handleRoleSelect(role.id)}>
              {role.label}
            </div>
          ))}
        </Card>
      </Col>
      <Col span={16}>
        <Card title="权限配置" size="small" extra={
          <PermissionGuard permission="system:role:manage">
            <Button type="primary" size="small" onClick={handleSave}>保存</Button>
          </PermissionGuard>
        }>
          {Object.entries(moduleLabels).map(([mod, label]) => (
            <div key={mod} style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{label}</div>
              <Space wrap>
                {permissions.filter(p => p.module === mod).map(perm => (
                  <Tag key={perm.id}
                    color={checkedKeys.includes(perm.id) ? '#6B8F71' : 'default'}
                    style={{ cursor: canUpdate ? 'pointer' : 'not-allowed' }}
                    onClick={() => {
                      if (!canUpdate) return;
                      setCheckedKeys(prev =>
                        prev.includes(perm.id) ? prev.filter(k => k !== perm.id) : [...prev, perm.id]
                      );
                    }}>
                    {perm.name}
                  </Tag>
                ))}
              </Space>
            </div>
          ))}
        </Card>
      </Col>
    </Row>
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

// ==================== 公告管理 ====================
function AnnouncementTab() {
  const [data, setData] = useState<AnnouncementItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<AnnouncementItem | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<AnnouncementStats | null>(null);
  const [statsTitle, setStatsTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    const [res, deptRes, userRes] = await Promise.all([
      announcementApi.getAdminList({ page, pageSize: 20 }),
      systemApi.getDepartments(),
      systemApi.getAllUsers(),
    ]);
    if (res.data) { setData(res.data.list); setTotal(res.data.total); }
    if (deptRes.data) setDepartments(deptRes.data);
    if (userRes.data) setUsers(userRes.data);
  };

  useEffect(() => { load(); }, [page]);

  const handleSave = async (values: any) => {
    const payload = {
      title: values.title,
      content: values.content || null,
      type: values.type || 'info',
      targetScope: values.targetScope || 'all',
      targetDeptId: values.targetScope === 'department' ? values.targetDeptId : null,
      targetUserIds: values.targetScope === 'user' ? values.targetUserIds : null,
    };

    if (editItem) {
      await announcementApi.update(editItem.id, payload);
    } else {
      await announcementApi.create(payload);
    }
    message.success(editItem ? '更新成功' : '发布成功');
    setModalOpen(false);
    setEditItem(null);
    form.resetFields();
    load();
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
  const scopeLabel: Record<string, string> = { all: '全部用户', department: '指定部门', user: '指定用户' };

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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { setSystemName } = useAppStore();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const res = await systemApi.getSettings();
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

      {/* OIDC 提供商由环境变量配置，无需在此开关；如需增减请编辑 server/.env 的 OIDC_PROVIDERS */}
    </div>
  );
}
