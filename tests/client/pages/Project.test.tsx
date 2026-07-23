import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from '@client/pages/Project';
import { systemApi } from '@client/api/system';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/system', () => ({
  systemApi: {
    canViewProjects: vi.fn(),
    getProjects: vi.fn(),
    getMyProjects: vi.fn(),
    getAllUsers: vi.fn(),
    getGroups: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    getProjectSEs: vi.fn(),
    addProjectSE: vi.fn(),
    removeProjectSE: vi.fn(),
    getProjectAllocations: vi.fn(),
    addProjectAllocation: vi.fn(),
    removeProjectAllocation: vi.fn(),
  },
}));

function setUser(permissions: string[], admin = false) {
  useAuthStore.setState({
    token: 'project-token',
    user: {
      id: 1,
      username: 'project-user',
      realName: '项目用户',
      department: null,
      group: null,
      roles: admin ? [{ id: 1, name: 'admin', label: '管理员' }] : [],
      permissions,
    },
  });
}

const project = {
  id: 10,
  name: '工时平台',
  code: 'WORKTIME',
  description: '项目描述',
  status: 'active',
  managers: [{ id: 1, realName: '项目用户' }],
  moduleSEs: [],
  workloadAllocations: [],
  canUpdate: false,
  canAssignSE: false,
  canAssignManager: false,
  canDelete: false,
};

describe('项目管理页面', () => {
  beforeEach(() => {
    vi.mocked(systemApi.canViewProjects).mockResolvedValue({
      code: 0, data: { canView: true, isAdmin: false, isManager: true },
    });
    vi.mocked(systemApi.getProjects).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getAllUsers).mockResolvedValue({ code: 0, data: [{
      id: 2, username: 'manager', realName: '项目负责人', departmentId: null, groupId: null,
    }] });
    vi.mocked(systemApi.getGroups).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.createProject).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.updateProject).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.deleteProject).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.getProjectSEs).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.addProjectSE).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.removeProjectSE).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.getProjectAllocations).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.addProjectAllocation).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.removeProjectAllocation).mockResolvedValue({ code: 0 });
  });

  it('非管理员只请求服务端判定的可见项目，并服从每条记录的操作标志', async () => {
    setUser(['project:access', 'project:view:managed']);
    vi.mocked(systemApi.canViewProjects).mockResolvedValue({
      code: 0, data: { canView: true, isAdmin: false, isManager: true },
    });
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({ code: 0, data: [project as any] });
    render(<ProjectPage />);

    expect(await screen.findByText('工时平台')).toBeInTheDocument();
    expect(systemApi.getMyProjects).toHaveBeenCalledTimes(1);
    expect(systemApi.getProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新增项目' })).not.toBeInTheDocument();
  });

  it('新增项目要求选择负责人，并提交与后端一致的字段', async () => {
    setUser(['project:access', 'project:create']);
    vi.mocked(systemApi.canViewProjects).mockResolvedValue({
      code: 0, data: { canView: true, isAdmin: false, isManager: false },
    });
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.click(await screen.findByRole('button', { name: /新增项目/ }));
    await user.type(screen.getByLabelText('项目名称'), '新项目');
    await user.type(screen.getByLabelText('项目编码'), 'NEW-PROJECT');
    await user.click(screen.getByLabelText('管理员'));
    await user.click(await screen.findByText('项目负责人（manager）'));
    await user.click(screen.getByRole('button', { name: /OK|确\s*定/ }));

    await waitFor(() => expect(systemApi.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: '新项目',
      code: 'NEW-PROJECT',
      managerIds: [2],
    })));
  });

  it('编辑项目不会把只读编码或无权维护的负责人字段发送给后端', async () => {
    setUser(['project:access', 'project:update']);
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({
      code: 0,
      data: [{ ...project, canUpdate: true } as any],
    });
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const name = screen.getByLabelText('项目名称');
    await user.clear(name);
    await user.type(name, '工时平台二期');
    await user.click(screen.getByRole('button', { name: /OK|确\s*定/ }));

    await waitFor(() => expect(systemApi.updateProject).toHaveBeenCalledWith(10, expect.objectContaining({
      name: '工时平台二期',
      status: 'active',
    })));
    const payload = vi.mocked(systemApi.updateProject).mock.calls[0][1];
    expect(payload).not.toHaveProperty('code');
    expect(payload).not.toHaveProperty('managerIds');
  });

  it('主列表加载失败时保留错误说明并允许原地重试', async () => {
    setUser(['project:access']);
    vi.mocked(systemApi.canViewProjects)
      .mockRejectedValueOnce(new Error('项目服务暂不可用'))
      .mockResolvedValueOnce({ code: 0, data: { canView: true, isAdmin: false, isManager: true } });
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({ code: 0, data: [project as any] });
    const user = userEvent.setup();
    render(<ProjectPage />);

    expect(await screen.findByText('项目服务暂不可用')).toBeInTheDocument();
    expect(screen.getAllByText('项目数据加载失败')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByText('工时平台')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('项目服务暂不可用')).not.toBeInTheDocument());
  });

  it('按操作能力最小化加载选择器，失败后可单独重试', async () => {
    setUser(['project:access', 'project:update']);
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({
      code: 0, data: [{ ...project, canUpdate: true } as any],
    });
    vi.mocked(systemApi.getGroups)
      .mockRejectedValueOnce(new Error('分组目录不可用'))
      .mockResolvedValueOnce({ code: 0, data: [] });
    const user = userEvent.setup();
    render(<ProjectPage />);

    expect(await screen.findByText('分组目录不可用')).toBeInTheDocument();
    expect(systemApi.getAllUsers).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(systemApi.getGroups).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('分组目录不可用')).not.toBeInTheDocument());
  });

  it('模块 SE 加载失败不会显示成空配置，并可在弹窗内重试', async () => {
    setUser(['project:access', 'project:assign_se']);
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({
      code: 0, data: [{ ...project, canAssignSE: true } as any],
    });
    vi.mocked(systemApi.getProjectSEs)
      .mockRejectedValueOnce(new Error('SE 配置读取失败'))
      .mockResolvedValueOnce({
        code: 0,
        data: [{ id: 9, projectId: 10, userId: 2, groupId: 3, user: { id: 2, realName: '王工' }, group: { id: 3, name: '平台组' } } as any],
      });
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.click(await screen.findByRole('button', { name: '配置SE' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('SE 配置读取失败')).toBeInTheDocument();
    expect(within(dialog).getByText('配置加载失败')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /重\s*试/ }));

    expect(await within(dialog).findByText('王工')).toBeInTheDocument();
    expect(within(dialog).getByText('平台组')).toBeInTheDocument();
  });

  it('非进行中项目只允许查看或删除既有配置，不展示必然失败的新增表单', async () => {
    setUser(['project:access', 'project:update', 'project:assign_se']);
    vi.mocked(systemApi.getMyProjects).mockResolvedValue({
      code: 0,
      data: [{ ...project, status: 'completed', canUpdate: true, canAssignSE: true } as any],
    });
    const user = userEvent.setup();
    render(<ProjectPage />);

    await user.click(await screen.findByRole('button', { name: '配置SE' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/不能新增模块 SE/)).toBeInTheDocument();
    expect(within(dialog).queryByText('添加SE')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: '配置工时' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/不能新增配额/)).toBeInTheDocument();
    expect(within(dialog).queryByText('添加/更新配额')).not.toBeInTheDocument();
  });
});
