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
  const { isAdmin: storeIsAdmin } = usePermission();
  const [serverIsAdmin, setServerIsAdmin] = useState(storeIsAdmin);
  const [isManager, setIsManager] = useState(false);
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
  // canEdit: 系统管理员或项目管理员都可以编辑
  const canEdit = isAdmin || isManager;

  const load = async () => {
    try {
      // 先检查权限
      const canViewRes = await systemApi.canViewProjects();
      if (canViewRes.data) {
        setServerIsAdmin(canViewRes.data.isAdmin);
        setIsManager(canViewRes.data.isManager && !canViewRes.data.isAdmin);
      }

      let projRes;
      if (canViewRes.data?.isAdmin) {
        projRes = await systemApi.getProjects();
      } else {
        projRes = await systemApi.getMyProjects();
      }
      if (projRes.data) setData(projRes.data);

      // 管理员和项目管理员都需要加载用户和分组列表（用于编辑表单和SE配置）
      if (canViewRes.data?.isAdmin || canViewRes.data?.isManager) {
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
    ...(canEdit ? [{
      title: '操作', key: 'action', width: isAdmin ? 260 : 200,
      render: (_: any, record: Project) => (
        <Space>
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
          {isAdmin && (
            <Popconfirm title="确定删除?" onConfirm={async () => { await systemApi.deleteProject(record.id); message.success('删除成功'); load(); }}>
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    }] : []),
  ];

  const seColumns = [
    { title: 'SE', key: 'user', render: (_: any, r: ProjectSE) => r.user?.realName || '-' },
    { title: '负责组', key: 'group', render: (_: any, r: ProjectSE) => r.group?.name || '-' },
    ...(canEdit ? [{
      title: '操作', key: 'action', width: 80,
      render: (_: any, r: ProjectSE) => (
        <Popconfirm title="确定删除?" onConfirm={async () => {
          await systemApi.removeProjectSE(r.id);
          message.success('删除成功');
          if (selectedProject) loadProjectSEs(selectedProject.id);
          load();
        }}>
          <Button type="link" size="small" danger>删除</Button>
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
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 16 }}
            onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true); }}>
            新增项目
          </Button>
        )}
        <Table rowKey="id" columns={columns} dataSource={data} pagination={false} size="middle"
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
            <Form.Item name="managerIds" label="管理员" rules={[{ required: true, message: '请选择至少一个管理员' }]}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" placeholder="选择项目管理员（可多选）"
                options={users.map(u => ({ label: u.realName, value: u.id }))} />
            </Form.Item>
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
            <Table rowKey="id" columns={seColumns} dataSource={projectSEs} pagination={false} size="small"
              locale={{ emptyText: '暂无SE配置' }} />
          </Card>
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
        </Modal>
      </Card>
    </div>
  );
}
