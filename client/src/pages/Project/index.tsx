import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Space, Modal, Form, Input, Select, Tag, message,
  Typography, Row, Col, Popconfirm,
} from 'antd';
import {
  PlusOutlined, ProjectOutlined,
} from '@ant-design/icons';
import { systemApi, SimpleUser } from '../../api/system';
import { Group, Project, ProjectSE, projectStatusMap } from '../../types';
import { usePermission } from '../../hooks/usePermission';

const { Title } = Typography;

export default function ProjectPage() {
  const { isAdmin: storeIsAdmin, hasPermission } = usePermission();
  const [serverIsAdmin, setServerIsAdmin] = useState(storeIsAdmin);
  const [data, setData] = useState<Project[]>([]);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [seModalOpen, setSeModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<Project | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectSEs, setProjectSEs] = useState<ProjectSE[]>([]);
  const [form] = Form.useForm();
  const [seForm] = Form.useForm();

  const isAdmin = serverIsAdmin;
  const canCreate = hasPermission('project:create');

  const load = async () => {
    try {
      // 先检查权限
      const canViewRes = await systemApi.canViewProjects();
      if (canViewRes.data) {
        setServerIsAdmin(canViewRes.data.isAdmin);
      }

      let projRes;
      if (canViewRes.data?.isAdmin) {
        projRes = await systemApi.getProjects();
      } else {
        projRes = await systemApi.getMyProjects();
      }
      const projects = projRes.data || [];
      setData(projects);

      // 管理员和项目管理员都需要加载用户和分组列表（用于编辑表单和SE配置）
      const needsSelectors = canCreate || projects.some((project) => project.canUpdate || project.canAssignSE || project.canAssignManager);
      if (needsSelectors) {
        try {
          const [userRes, groupRes] = await Promise.all([
            systemApi.getAllUsers(),
            systemApi.getGroups(),
          ]);
          if (userRes.data) setUsers(userRes.data);
          if (groupRes.data) setGroups(groupRes.data);
        } catch {
          // 非系统管理员可能无权限，忽略
        }
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '加载项目数据失败');
    }
  };

  useEffect(() => { load(); }, []);

  const loadProjectSEs = async (projectId: number) => {
    const res = await systemApi.getProjectSEs(projectId);
    if (res.data) setProjectSEs(res.data);
  };

  const handleSave = async (values: any) => {
    const payload = { ...values };
    if (editItem && !editItem.canAssignManager) delete payload.managerIds;
    if (editItem) {
      await systemApi.updateProject(editItem.id, payload);
    } else {
      await systemApi.createProject(payload);
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
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s: string) => {
        const info = projectStatusMap[s] || { label: s, color: 'default' };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
    {
      title: '\u64cd\u4f5c', key: 'action', width: 260,
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
            {record.canDelete && (
              <Popconfirm title={'\u786e\u5b9a\u5220\u9664?'} onConfirm={async () => { await systemApi.deleteProject(record.id); message.success('\u5220\u9664\u6210\u529f'); load(); }}>
                <Button type="link" size="small" danger>{'\u5220\u9664'}</Button>
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
        <Popconfirm title={'\u786e\u5b9a\u5220\u9664?'} onConfirm={async () => {
          await systemApi.removeProjectSE(r.id);
          message.success('\u5220\u9664\u6210\u529f');
          if (selectedProject) loadProjectSEs(selectedProject.id);
          load();
        }}>
          <Button type="link" size="small" danger>{'\u5220\u9664'}</Button>
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
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
            onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true); }}>
            新增项目
          </Button>
        )}
        <Table rowKey="id" columns={columns} dataSource={data} pagination={{ pageSize: 10 }} size="middle"
          locale={{ emptyText: isAdmin ? '暂无项目' : '您暂无负责的项目' }} />

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
            {(!editItem || editItem.canAssignManager) && (
              <Form.Item name="managerIds" label={'\u7ba1\u7406\u5458'} rules={[{ required: true, message: '\u8bf7\u9009\u62e9\u81f3\u5c11\u4e00\u4e2a\u7ba1\u7406\u5458' }]}>
                <Select mode="multiple" allowClear showSearch optionFilterProp="label" placeholder={'\u9009\u62e9\u9879\u76ee\u7ba1\u7406\u5458\uff08\u53ef\u591a\u9009\uff09'}
                  options={users.map(u => ({ label: u.realName, value: u.id }))} />
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
          {selectedProject?.canAssignSE && (
            <Card size="small" title={'\u6dfb\u52a0SE'}>
              <Form form={seForm} layout="inline" onFinish={handleAddSE}>
                <Form.Item name="userId" label="SE" rules={[{ required: true }]}>
                  <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                    options={users.map(u => ({ label: u.realName, value: u.id }))} />
                </Form.Item>
                <Form.Item name="groupId" label={'\u8d1f\u8d23\u7ec4'} rules={[{ required: true }]}>
                  <Select showSearch optionFilterProp="label" style={{ width: 150 }}
                    options={groups.map(g => ({ label: g.name, value: g.id }))} />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit">{'\u6dfb\u52a0'}</Button>
                </Form.Item>
              </Form>
            </Card>
          )}
        </Modal>
      </Card>
    </div>
  );
}
