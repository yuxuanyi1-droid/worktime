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
import { Department, Group, Role, Permission, Project, ProjectSE, ApprovalFlow, ApprovalFlowStep, stepTypeMap } from '../../types';
import { announcementApi, AnnouncementItem, AnnouncementStats } from '../../api/notification';
import { useAppStore } from '../../stores/appStore';
import { usePermission } from '../../hooks/usePermission';

const { Title, Text } = Typography;

function PermissionGuard({ permission, children }: { permission: string; children: ReactNode }) {
  const { hasPermission } = usePermission();
  return hasPermission(permission) ? <>{children}</> : null;
}

export default function System() {
  const [tabKey, setTabKey] = useState('org');

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>系统管理</Title>
      <Card style={{ borderRadius: 12 }}>
        <Tabs activeKey={tabKey} onChange={setTabKey} items={[
          { key: 'org', label: '组织架构' },
          { key: 'user', label: '用户管理' },
          { key: 'role', label: '角色权限' },
          { key: 'approval-flow', label: '审批流程' },
          { key: 'announcement', label: '公告管理' },
          { key: 'settings', label: '系统设置' },
        ]} />

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

// ==================== 组织架构管理（部门+多层级分组） ====================
function OrgTab() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [groupTree, setGroupTree] = useState<any[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editDept, setEditDept] = useState<Department | null>(null);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const [deptForm] = Form.useForm();
  const [groupForm] = Form.useForm();

  const load = async () => {
    const [deptRes, userRes] = await Promise.all([
      systemApi.getDepartments(),
      systemApi.getAllUsers(),
    ]);
    if (deptRes.data) setDepartments(deptRes.data);
    if (userRes.data) setUsers(userRes.data);

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

  const handleDeptSave = async (values: any) => {
    if (editDept) {
      await systemApi.updateDepartment(editDept.id, values);
    } else {
      await systemApi.createDepartment(values);
    }
    message.success('操作成功');
    setDeptModalOpen(false);
    deptForm.resetFields();
    setEditDept(null);
    load();
  };

  const handleGroupSave = async (values: any) => {
    if (editGroup) {
      await systemApi.updateGroup(editGroup.id, values);
    } else {
      await systemApi.createGroup(values);
    }
    message.success('操作成功');
    setGroupModalOpen(false);
    groupForm.resetFields();
    setEditGroup(null);
    load();
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
          <span style={{ marginLeft: 8 }}>
          <PermissionGuard permission="system:create">
            <Tooltip title="添加子组"><PlusOutlined style={{ color: '#4A8B5E', cursor: 'pointer' }} onClick={() => {
              setEditGroup(null);
              groupForm.resetFields();
              groupForm.setFieldsValue({ departmentId: g.departmentId, parentId: g.id });
              setGroupModalOpen(true);
            }} /></Tooltip>
          </PermissionGuard>
          <PermissionGuard permission="system:update">
            <Tooltip title="编辑"><EditOutlined style={{ color: '#6B8F71', marginLeft: 8, cursor: 'pointer' }} onClick={() => {
              setEditGroup(g);
              groupForm.setFieldsValue({ name: g.name, description: g.description, leaderId: g.leader?.id, parentId: g.parentId, departmentId: g.departmentId });
              setGroupModalOpen(true);
            }} /></Tooltip>
          </PermissionGuard>
          <PermissionGuard permission="system:delete">
            <Popconfirm title="确定删除?" onConfirm={async () => { await systemApi.deleteGroup(g.id); message.success('删除成功'); load(); }}>
              <DeleteOutlined style={{ color: '#C0564B', marginLeft: 8, cursor: 'pointer' }} />
            </Popconfirm>
          </PermissionGuard>
          </span>
        </span>
      ),
      children: [
        ...(g.members?.length ? [{
          key: `members-${g.id}`,
          title: (
            <span style={{ color: '#7A7060', fontSize: 12 }}>
              <UserOutlined style={{ marginRight: 4 }} />
              {g.members.map((m: any) => (
                <Tag key={m.id} style={{ fontSize: 11, marginRight: 4, marginBottom: 2 }}
                  color={g.leader?.id === m.id ? 'blue' : 'default'}>
                  {m.realName}{g.leader?.id === m.id ? '(负责人)' : ''}
                </Tag>
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
            <span style={{ marginLeft: 8 }}>
              <PermissionGuard permission="system:update">
                <Tooltip title="编辑"><EditOutlined style={{ color: '#6B8F71', cursor: 'pointer' }} onClick={() => {
                  setEditDept(dept);
                  deptForm.setFieldsValue({ name: dept.name, description: dept.description, leaderId: dept.leader?.id });
                  setDeptModalOpen(true);
                }} /></Tooltip>
              </PermissionGuard>
              <PermissionGuard permission="system:delete">
                <Popconfirm title="确定删除?" onConfirm={async () => { await systemApi.deleteDepartment(dept.id); message.success('删除成功'); load(); }}>
                  <DeleteOutlined style={{ color: '#C0564B', marginLeft: 8, cursor: 'pointer' }} />
                </Popconfirm>
              </PermissionGuard>
            </span>
          </span>
        ),
        children: [
          // 在该部门下添加分组按钮
          {
            key: `add-group-${dept.id}`,
            title: (
              <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={() => {
                setEditGroup(null);
                groupForm.resetFields();
                groupForm.setFieldsValue({ departmentId: dept.id });
                setGroupModalOpen(true);
              }}>添加分组</Button>
            ),
            selectable: false,
            children: buildTreeData(groupTree.filter((g: any) => g.departmentId === dept.id)),
          },
        ],
      })),
  ];

  // 获取所有分组平铺列表（用于选择父级）
  const flattenGroups = (groups: any[], result: { id: number; name: string; level: number }[] = []) => {
    for (const g of groups) {
      result.push({ id: g.id, name: g.name, level: g.level || 0 });
      if (g.children?.length) flattenGroups(g.children, result);
    }
    return result;
  };

  const allGroupsFlat = flattenGroups(groupTree);

  return (
    <div>
      <Row gutter={16}>
        <Col span={6}>
          <Card title="部门列表" size="small" extra={
            <PermissionGuard permission="system:create">
              <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => {
                setEditDept(null);
                deptForm.resetFields();
                setDeptModalOpen(true);
              }}>新增</Button>
            </PermissionGuard>
          }>
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
              <Space>
                <Button size="small" icon={<PlusOutlined />} onClick={() => {
                  setEditGroup(null);
                  groupForm.resetFields();
                  if (selectedDeptId) groupForm.setFieldsValue({ departmentId: selectedDeptId });
                  setGroupModalOpen(true);
                }}>新增分组</Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={load} />
              </Space>
            }>
            {treeData.length ? (
              <Tree treeData={treeData} defaultExpandAll blockNode />
            ) : (
              <Empty description="暂无组织架构" />
            )}
          </Card>
        </Col>
      </Row>

      {/* 部门编辑 Modal */}
      <Modal title={editDept ? '编辑部门' : '新增部门'} open={deptModalOpen}
        onCancel={() => { setDeptModalOpen(false); setEditDept(null); }} onOk={() => deptForm.submit()}>
        <Form form={deptForm} layout="vertical" onFinish={handleDeptSave}>
          <Form.Item name="name" label="部门名称" rules={[{ required: true, message: '请输入' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="leaderId" label="部门负责人">
            <Select allowClear showSearch optionFilterProp="label"
              placeholder="选择负责人"
              options={users.map(u => ({ label: u.realName, value: u.id }))} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 分组编辑 Modal */}
      <Modal title={editGroup ? '编辑分组' : '新增分组'} open={groupModalOpen}
        onCancel={() => { setGroupModalOpen(false); setEditGroup(null); }} onOk={() => groupForm.submit()}>
        <Form form={groupForm} layout="vertical" onFinish={handleGroupSave}>
          <Form.Item name="name" label="分组名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="departmentId" label="所属部门">
            <Select allowClear placeholder="选择部门" options={departments.map(d => ({ label: d.name, value: d.id }))} />
          </Form.Item>
          <Form.Item name="parentId" label="上级分组">
            <Select allowClear placeholder="无（顶级组）" options={allGroupsFlat.map(g => ({
              label: `${'　'.repeat(g.level)}${g.name}`, value: g.id,
            }))} />
          </Form.Item>
          <Form.Item name="leaderId" label="负责人">
            <Select allowClear showSearch optionFilterProp="label"
              placeholder="选择负责人"
              options={users.map(u => ({ label: u.realName, value: u.id }))} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
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
  const buildGroupSelectTree = (): any[] => {
    return departments.map(dept => ({
      title: dept.name,
      value: `dept-${dept.id}`,
      key: `dept-${dept.id}`,
      disabled: true,
      selectable: false,
      children: buildGroupNodes(groupTreeData.filter((g: any) => g.departmentId === dept.id)),
    }));
  };

  const buildGroupNodes = (groups: any[]): any[] => {
    return groups.map(g => ({
      title: g.name + (g.leader ? ` (${g.leader.realName})` : ''),
      value: g.id,
      key: `group-${g.id}`,
      children: g.children?.length ? buildGroupNodes(g.children) : [],
    }));
  };

  const groupSelectTreeData = buildGroupSelectTree();

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
      <Modal title={editItem ? '编辑用户' : '新增用户'} open={modalOpen} width={600}
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
  const canUpdate = hasPermission('system:update');
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
          <PermissionGuard permission="system:update">
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
  const [editItem, setEditItem] = useState<any | null>(null);
  const [selectedProject, setSelectedProject] = useState<any>(null);
  const [projectSEs, setProjectSEs] = useState<ProjectSE[]>([]);
  const [form] = Form.useForm();
  const [seForm] = Form.useForm();

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
    { title: '状态', dataIndex: 'status', width: 80, render: (s: number) => <Tag color={s === 1 ? 'green' : 'default'}>{s === 1 ? '进行中' : '已结束'}</Tag> },
    {
      title: '操作', key: 'action', width: 260,
      render: (_: any, record: any) => (
        <Space>
          <PermissionGuard permission="system:update">
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
          </PermissionGuard>
          <PermissionGuard permission="system:delete">
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
        <PermissionGuard permission="system:delete">
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
      <Table rowKey="id" columns={columns} dataSource={data} pagination={false} size="middle" />

      {/* 项目编辑 Modal */}
      <Modal title={editItem ? '编辑项目' : '新增项目'} open={modalOpen}
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
          <Table rowKey="id" columns={seColumns} dataSource={projectSEs} pagination={false} size="small"
            locale={{ emptyText: '暂无SE配置' }} />
        </Card>
        <PermissionGuard permission="system:update">
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
    </>
  );
}

// ==================== 审批流程配置 ====================
function ApprovalFlowTab() {
  const [flows, setFlows] = useState<ApprovalFlow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editFlow, setEditFlow] = useState<ApprovalFlow | null>(null);
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
    timesheet: '工时审批', overtime: '加班审批', weekly_report: '周报审批',
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
          <PermissionGuard permission="system:update">
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
          <PermissionGuard permission="system:delete">
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
      <Table rowKey="id" columns={columns} dataSource={flows} pagination={false} size="middle" />

      <Modal title={editFlow ? '编辑审批流程' : '新增审批流程'} open={modalOpen} width={700}
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
            编辑
          </Button>
          <Popconfirm title="确定删除?" onConfirm={async () => {
            await announcementApi.delete(record.id);
            message.success('删除成功');
            load();
          }}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PermissionGuard permission="system:create">
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
      <Modal title={editItem ? '编辑公告' : '发布公告'} open={modalOpen} width={640}
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
  const [timesheetUnit, setTimesheetUnit] = useState<string>('days');
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
        setTimesheetUnit(res.data.settings.timesheet_unit);
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
          <PermissionGuard permission="system:update">
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
              <Radio.Button value="days">天（0.5 / 1）</Radio.Button>
              <Radio.Button value="hours">小时（0.5 ~ 24）</Radio.Button>
            </Radio.Group>
          </Col>
          <Col>
            <Button type="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </Col>
        </Row>
        <div style={{ marginTop: 12, color: '#888', fontSize: 13 }}>
          {timesheetUnit === 'days'
            ? '天模式：每天最多填1天，最小单位0.5天，提交时校验周合计不得少于5天'
            : '小时模式：每天最多填24小时，最小单位0.5小时，提交时校验周合计不得少于40小时'}
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
          <PermissionGuard permission="system:update">
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
    </div>
  );
}
