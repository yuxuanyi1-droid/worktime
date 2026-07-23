import { useEffect, useRef, useState } from 'react';
import {
  Alert, Card, Table, Button, Space, Modal, Form, Input, InputNumber, Select, Tag, message,
  Typography, Popconfirm,
} from 'antd';
import {
  PlusOutlined, ProjectOutlined,
} from '@ant-design/icons';
import { systemApi, SimpleUser } from '../../api/system';
import { Group, Project, ProjectSE, ProjectWorkloadAllocation, projectStatusMap } from '../../types';
import { usePermission } from '../../hooks/usePermission';

const { Title } = Typography;

function getErrorMessage(error: unknown, fallback: string) {
  const value = error as { response?: { data?: { message?: string } }; message?: string };
  return value.response?.data?.message || value.message || fallback;
}

export default function ProjectPage() {
  const { isAdmin: storeIsAdmin, hasPermission } = usePermission();
  const [serverIsAdmin, setServerIsAdmin] = useState(storeIsAdmin);
  const [data, setData] = useState<Project[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [seModalOpen, setSeModalOpen] = useState(false);
  const [allocationModalOpen, setAllocationModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<Project | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectSEs, setProjectSEs] = useState<ProjectSE[]>([]);
  const [projectAllocations, setProjectAllocations] = useState<ProjectWorkloadAllocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seLoading, setSeLoading] = useState(false);
  const [allocationLoading, setAllocationLoading] = useState(false);
  const [selectorLoading, setSelectorLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectorError, setSelectorError] = useState('');
  const [seError, setSeError] = useState('');
  const [allocationError, setAllocationError] = useState('');
  const [deletingProjectId, setDeletingProjectId] = useState<number | null>(null);
  const [removingSeId, setRemovingSeId] = useState<number | null>(null);
  const [removingAllocationId, setRemovingAllocationId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [seForm] = Form.useForm();
  const [allocationForm] = Form.useForm();
  const loadRequestId = useRef(0);
  const selectorRequestId = useRef(0);
  const selectorNeeds = useRef({ users: false, groups: false });
  const seRequestId = useRef(0);
  const allocationRequestId = useRef(0);

  const isAdmin = serverIsAdmin;
  const canCreate = hasPermission('project:create');

  const userOptions = users.map(user => ({
    label: `${user.realName}（${user.username}）`,
    value: user.id,
  }));
  const groupOptions = groups.map(group => ({
    label: `${group.department?.name ? `${group.department.name} / ` : ''}${group.name}`,
    value: group.id,
  }));

  const loadSelectors = async (needs = selectorNeeds.current) => {
    const requestId = ++selectorRequestId.current;
    setSelectorLoading(true);
    setSelectorError('');
    try {
      const [userRes, groupRes] = await Promise.all([
        needs.users ? systemApi.getAllUsers() : Promise.resolve(null),
        needs.groups ? systemApi.getGroups() : Promise.resolve(null),
      ]);
      if (requestId !== selectorRequestId.current) return;
      setUsers(userRes?.data || []);
      setGroups(groupRes?.data || []);
    } catch (error) {
      if (requestId !== selectorRequestId.current) return;
      setUsers([]);
      setGroups([]);
      setSelectorError(getErrorMessage(error, '人员和分组选项加载失败，部分配置功能暂不可用'));
    } finally {
      if (requestId === selectorRequestId.current) setSelectorLoading(false);
    }
  };

  const load = async () => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setLoadError('');
    try {
      const canViewRes = await systemApi.canViewProjects();
      if (!canViewRes.data) throw new Error('项目可见范围返回异常');
      if (requestId !== loadRequestId.current) return;
      setServerIsAdmin(canViewRes.data.isAdmin);

      const projRes = canViewRes.data.isAdmin
        ? await systemApi.getProjects()
        : await systemApi.getMyProjects();
      if (requestId !== loadRequestId.current) return;
      const projects = projRes.data || [];
      setData(projects);

      const needs = {
        users: canCreate || projects.some((project) => project.canAssignManager || project.canAssignSE),
        groups: projects.some((project) => project.canUpdate || project.canAssignSE),
      };
      selectorNeeds.current = needs;
      if (needs.users || needs.groups) {
        await loadSelectors(needs);
      } else {
        setUsers([]);
        setGroups([]);
        setSelectorError('');
      }
    } catch (error) {
      if (requestId === loadRequestId.current) {
        setLoadError(getErrorMessage(error, '加载项目数据失败'));
        setData([]);
      }
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const loadProjectSEs = async (projectId: number) => {
    const requestId = ++seRequestId.current;
    setSeLoading(true);
    setSeError('');
    setProjectSEs([]);
    try {
      const res = await systemApi.getProjectSEs(projectId);
      if (requestId === seRequestId.current) setProjectSEs(res.data || []);
    } catch (error) {
      if (requestId === seRequestId.current) {
        setSeError(getErrorMessage(error, '模块 SE 配置加载失败'));
      }
    } finally {
      if (requestId === seRequestId.current) setSeLoading(false);
    }
  };

  const loadProjectAllocations = async (projectId: number) => {
    const requestId = ++allocationRequestId.current;
    setAllocationLoading(true);
    setAllocationError('');
    setProjectAllocations([]);
    try {
      const res = await systemApi.getProjectAllocations(projectId);
      if (requestId === allocationRequestId.current) setProjectAllocations(res.data || []);
    } catch (error) {
      if (requestId === allocationRequestId.current) {
        setAllocationError(getErrorMessage(error, '工时配额加载失败'));
      }
    } finally {
      if (requestId === allocationRequestId.current) setAllocationLoading(false);
    }
  };

  const handleAddAllocation = async (values: any) => {
    if (!selectedProject) return;
    setSaving(true);
    try {
      await systemApi.addProjectAllocation(selectedProject.id, values);
      message.success('保存成功');
      allocationForm.resetFields();
      await Promise.all([loadProjectAllocations(selectedProject.id), load()]);
    } catch (error) {
      message.error(getErrorMessage(error, '工时配额保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const payload = { ...values };
      if (editItem) {
        delete payload.code;
        if (!editItem.canAssignManager) delete payload.managerIds;
        await systemApi.updateProject(editItem.id, payload);
      } else {
        await systemApi.createProject(payload);
      }
      message.success('操作成功');
      setModalOpen(false);
      form.resetFields();
      setEditItem(null);
      await load();
    } catch (error) {
      message.error(getErrorMessage(error, '项目保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleAddSE = async (values: any) => {
    if (!selectedProject) return;
    setSaving(true);
    try {
      await systemApi.addProjectSE(selectedProject.id, values);
      message.success('添加成功');
      seForm.resetFields();
      await Promise.all([loadProjectSEs(selectedProject.id), load()]);
    } catch (error) {
      message.error(getErrorMessage(error, '模块 SE 保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProject = async (projectId: number) => {
    if (deletingProjectId !== null) return;
    setDeletingProjectId(projectId);
    try {
      await systemApi.deleteProject(projectId);
      message.success('删除成功');
      await load();
    } catch (error) {
      message.error(getErrorMessage(error, '项目删除失败'));
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleRemoveSE = async (id: number) => {
    if (removingSeId !== null) return;
    setRemovingSeId(id);
    try {
      await systemApi.removeProjectSE(id);
      message.success('删除成功');
      if (selectedProject) await Promise.all([loadProjectSEs(selectedProject.id), load()]);
    } catch (error) {
      message.error(getErrorMessage(error, '模块 SE 删除失败'));
    } finally {
      setRemovingSeId(null);
    }
  };

  const handleRemoveAllocation = async (id: number) => {
    if (removingAllocationId !== null) return;
    setRemovingAllocationId(id);
    try {
      await systemApi.removeProjectAllocation(id);
      message.success('删除成功');
      if (selectedProject) await Promise.all([loadProjectAllocations(selectedProject.id), load()]);
    } catch (error) {
      message.error(getErrorMessage(error, '工时配额删除失败'));
    } finally {
      setRemovingAllocationId(null);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '项目名称', dataIndex: 'name' },
    { title: '项目编码', dataIndex: 'code' },
    { title: '管理员', key: 'managers', width: 200, render: (_: any, r: Project) => {
      const managers = r.managers || [];
      return managers.length ? managers.map((m: any) => (
        <Tag key={m.id} color="blue">{m.realName}</Tag>
      )) : <Tag>未指定</Tag>;
    }},
    { title: '模块SE', key: 'se', width: 200, render: (_: any, r: Project) => {
      const ses = r.moduleSEs || [];
      return ses.length ? ses.map((se: ProjectSE) => (
        <Tag key={se.id} color="purple">{se.user?.realName} → {se.group?.name}</Tag>
      )) : <Tag>未配置</Tag>;
    }},
    { title: '工时配额', key: 'allocations', width: 200, render: (_: any, r: Project) => {
      const allocs = r.workloadAllocations || [];
      return allocs.length ? allocs.map((a: ProjectWorkloadAllocation) => (
        <Tag key={a.id} color="cyan">{a.groupName}: {a.allocation}天</Tag>
      )) : <Tag>未配置</Tag>;
    }},
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s: string) => {
        const info = projectStatusMap[s] || { label: s, color: 'default' };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: '\u64cd\u4f5c', key: 'action', width: 340,
      render: (_: any, record: Project) => {
        const hasActions = record.canUpdate || record.canAssignSE || record.canDelete;
        if (!hasActions) return '-';
        return (
          <Space>
            {record.canUpdate && (
              <Button type="link" size="small" onClick={() => {
                setEditItem(record);
                form.setFieldsValue({
                  ...record,
                  managerIds: (record.managers || []).map((m: any) => m.id),
                });
                setModalOpen(true);
              }}>{'\u7f16\u8f91'}</Button>
            )}
            {record.canAssignSE && (
              <Button type="link" size="small" onClick={() => {
                setSelectedProject(record);
                loadProjectSEs(record.id);
                seForm.resetFields();
                setSeModalOpen(true);
              }}>{'\u914d\u7f6eSE'}</Button>
            )}
            {record.canUpdate && (
              <Button type="link" size="small" onClick={() => {
                setSelectedProject(record);
                loadProjectAllocations(record.id);
                allocationForm.resetFields();
                setAllocationModalOpen(true);
              }}>配置工时</Button>
            )}
            {record.canDelete && (
              <Popconfirm title={'\u786e\u5b9a\u5220\u9664?'} onConfirm={() => handleDeleteProject(record.id)}>
                <Button type="link" size="small" danger loading={deletingProjectId === record.id}
                  disabled={deletingProjectId !== null && deletingProjectId !== record.id}>{'\u5220\u9664'}</Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  const seColumns = [
    { title: 'SE', key: 'user', render: (_: any, r: ProjectSE) => r.user?.realName || '-' },
    { title: '负责组', key: 'group', render: (_: any, r: ProjectSE) => r.group?.name || '-' },
    ...(selectedProject?.canAssignSE ? [{
      title: '\u64cd\u4f5c', key: 'action', width: 80,
      render: (_: any, r: ProjectSE) => (
        <Popconfirm title={'\u786e\u5b9a\u5220\u9664?'} onConfirm={() => handleRemoveSE(r.id)}>
          <Button type="link" size="small" danger loading={removingSeId === r.id}
            disabled={removingSeId !== null && removingSeId !== r.id}>{'\u5220\u9664'}</Button>
        </Popconfirm>
      ),
    }] : []),
  ];

  return (
    <div>
      <Title level={4} style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 700, letterSpacing: '-0.01em' }}>
        <ProjectOutlined style={{ marginRight: 8 }} />
        项目管理
      </Title>
      <Card style={{ borderRadius: 12 }}>
        {loadError && (
          <Alert type="error" showIcon message="项目数据加载失败" description={loadError}
            action={<Button size="small" onClick={load} loading={loading}>重试</Button>}
            style={{ marginBottom: 16 }} />
        )}
        {selectorError && (
          <Alert type="warning" showIcon message="配置选项加载失败" description={selectorError}
            action={<Button size="small" onClick={() => loadSelectors()} loading={selectorLoading}>重试</Button>}
            style={{ marginBottom: 16 }} />
        )}
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
            onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true); }}>
            新增项目
          </Button>
        )}
        <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={{ pageSize: 10 }} size="middle"
          locale={{ emptyText: loadError ? '项目数据加载失败' : (isAdmin ? '暂无项目' : '您暂无负责的项目') }} />

        {/* 项目编辑 Modal */}
        <Modal title={editItem ? '编辑项目' : '新增项目'} open={modalOpen}
          confirmLoading={saving}
          maskClosable={!saving}
          onCancel={() => { if (!saving) { setModalOpen(false); setEditItem(null); } }} onOk={() => form.submit()}>
          <Form form={form} layout="vertical" onFinish={handleSave}>
            <Form.Item name="name" label="项目名称" rules={[{ required: true }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="code" label="项目编码" rules={[{ required: true }]}>
              <Input disabled={!!editItem} maxLength={50} placeholder="如: PROJ-001" />
            </Form.Item>
            {(!editItem || editItem.canAssignManager) && (
              <Form.Item name="managerIds" label={'\u7ba1\u7406\u5458'} rules={[{ required: true, message: '\u8bf7\u9009\u62e9\u81f3\u5c11\u4e00\u4e2a\u7ba1\u7406\u5458' }]}>
                <Select mode="multiple" allowClear showSearch optionFilterProp="label" placeholder={'\u9009\u62e9\u9879\u76ee\u7ba1\u7406\u5458\uff08\u53ef\u591a\u9009\uff09'}
                  loading={selectorLoading} disabled={!!selectorError} options={userOptions} />
              </Form.Item>
            )}
            {editItem && (
              <Form.Item name="status" label="项目状态" rules={[{ required: true, message: '请选择项目状态' }]}>
                <Select placeholder="请选择项目状态" options={[
                  { label: '进行中', value: 'active' },
                  { label: '已完成', value: 'completed' },
                  { label: '已中止', value: 'suspended' },
                  { label: '已取消', value: 'cancelled' },
                ]} />
              </Form.Item>
            )}
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={2} maxLength={255} showCount />
            </Form.Item>
          </Form>
        </Modal>

        {/* SE 配置 Modal */}
        <Modal title={`配置模块SE - ${selectedProject?.name || ''}`} open={seModalOpen}
          maskClosable={!saving}
          onCancel={() => {
            if (saving) return;
            seRequestId.current += 1;
            setSeLoading(false);
            setSeModalOpen(false);
            setSelectedProject(null);
            setSeError('');
          }} footer={null} width={600}>
          {seError && selectedProject && (
            <Alert type="error" showIcon message="模块 SE 配置加载失败" description={seError}
              action={<Button size="small" onClick={() => loadProjectSEs(selectedProject.id)} loading={seLoading}>重试</Button>}
              style={{ marginBottom: 16 }} />
          )}
          <Card size="small" title="已有SE" style={{ marginBottom: 16 }}>
            <Table rowKey="id" columns={seColumns} dataSource={projectSEs} loading={seLoading} pagination={{ pageSize: 10 }} size="small"
              locale={{ emptyText: seError ? '配置加载失败' : '暂无SE配置' }} />
          </Card>
          {selectedProject?.canAssignSE && selectedProject.status === 'active' && (
            <Card size="small" title={'\u6dfb\u52a0SE'}>
              <Form form={seForm} layout="inline" onFinish={handleAddSE}>
                <Form.Item name="userId" label="SE" rules={[{ required: true }]}>
                  <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                    loading={selectorLoading} disabled={!!selectorError} options={userOptions} />
                </Form.Item>
                <Form.Item name="groupId" label={'\u8d1f\u8d23\u7ec4'} rules={[{ required: true }]}>
                  <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                    loading={selectorLoading} disabled={!!selectorError} options={groupOptions} />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" loading={saving}>{'\u6dfb\u52a0'}</Button>
                </Form.Item>
              </Form>
            </Card>
          )}
          {selectedProject?.canAssignSE && selectedProject.status !== 'active' && (
            <Alert type="info" showIcon message="该项目不是进行中状态，只能查看或删除现有配置，不能新增模块 SE。" />
          )}
        </Modal>

        {/* 工时配额 Modal */}
        <Modal title={`配置工时配额 - ${selectedProject?.name || ''}`} open={allocationModalOpen}
          maskClosable={!saving}
          onCancel={() => {
            if (saving) return;
            allocationRequestId.current += 1;
            setAllocationLoading(false);
            setAllocationModalOpen(false);
            setSelectedProject(null);
            setAllocationError('');
          }} footer={null} width={600}>
          {allocationError && selectedProject && (
            <Alert type="error" showIcon message="工时配额加载失败" description={allocationError}
              action={<Button size="small" onClick={() => loadProjectAllocations(selectedProject.id)} loading={allocationLoading}>重试</Button>}
              style={{ marginBottom: 16 }} />
          )}
          <div style={{ marginBottom: 12, color: '#9A9080', fontSize: 12 }}>
            按组配置工时配额（单位：人/天）。用户提交工时后，审批单中会动态展示该组在本项目的配额消耗，超额时向审批人警告。未配置的组不限制。
          </div>
          <Card size="small" title="已有配额" style={{ marginBottom: 16 }}>
            <Table rowKey="id" dataSource={projectAllocations} loading={allocationLoading} pagination={{ pageSize: 10 }} size="small"
              locale={{ emptyText: allocationError ? '配额加载失败' : '暂无配额配置' }}
              columns={[
                { title: '组', key: 'groupName', dataIndex: 'groupName' },
                { title: '配额(人/天)', key: 'allocation', dataIndex: 'allocation', width: 120 },
                ...(selectedProject?.canUpdate ? [{
                  title: '操作', key: 'action', width: 80,
                  render: (_: any, r: ProjectWorkloadAllocation) => (
                    <Popconfirm title="确定删除?" onConfirm={() => handleRemoveAllocation(r.id)}>
                      <Button type="link" size="small" danger loading={removingAllocationId === r.id}
                        disabled={removingAllocationId !== null && removingAllocationId !== r.id}>删除</Button>
                    </Popconfirm>
                  ),
                }] : []),
              ]}
            />
          </Card>
          {selectedProject?.canUpdate && selectedProject.status === 'active' && (
            <Card size="small" title="添加/更新配额">
              <Form form={allocationForm} layout="inline" onFinish={handleAddAllocation}>
                <Form.Item name="groupId" label="组" rules={[{ required: true }]}>
                  <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                    placeholder="选择组"
                    loading={selectorLoading} disabled={!!selectorError} options={groupOptions} />
                </Form.Item>
                <Form.Item name="allocation" label="配额" rules={[{ required: true, message: '请输入配额' }]}>
                  <InputNumber min={0} max={1_000_000} step={0.5} style={{ width: 100 }} placeholder="人/天" />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
                </Form.Item>
              </Form>
              <div style={{ marginTop: 8, color: '#aaa', fontSize: 12 }}>
                同一项目同一组重复保存会覆盖原配额值。
              </div>
            </Card>
          )}
          {selectedProject?.canUpdate && selectedProject.status !== 'active' && (
            <Alert type="info" showIcon message="该项目不是进行中状态，只能查看或删除现有配额，不能新增配额。" />
          )}
        </Modal>
      </Card>
    </div>
  );
}
