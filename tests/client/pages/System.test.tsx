import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import System from '@client/pages/System';
import { systemApi } from '@client/api/system';
import { announcementApi } from '@client/api/notification';
import { auditApi } from '@client/api/audit';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/system', () => ({
  systemApi: {
    getUsers: vi.fn(),
    getDepartments: vi.fn(),
    createDepartment: vi.fn(),
    updateDepartment: vi.fn(),
    deleteDepartment: vi.fn(),
    getGroupTree: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    getRoles: vi.fn(),
    resetPassword: vi.fn(),
    updateUser: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    getAllUsers: vi.fn(),
    getPermissions: vi.fn(),
    initPermissions: vi.fn(),
    updateRolePermissions: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
    getGroups: vi.fn(),
    getApprovalFlows: vi.fn(),
    createApprovalFlow: vi.fn(),
    updateApprovalFlow: vi.fn(),
    deleteApprovalFlow: vi.fn(),
    getSettings: vi.fn(),
    updateSetting: vi.fn(),
  },
}));

vi.mock('@client/api/notification', () => ({
  announcementApi: {
    getAdminList: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getStats: vi.fn(),
  },
}));

vi.mock('@client/api/audit', () => ({
  auditApi: { getList: vi.fn() },
}));

function setPermissions(permissions: string[]) {
  useAuthStore.setState({
    token: 'token',
    user: {
      id: 1,
      username: 'admin',
      realName: '管理员',
      department: null,
      group: null,
      roles: [],
      permissions,
    },
  });
}

describe('系统用户管理页面', () => {
  beforeEach(() => {
    setPermissions(['system:access', 'system:user:manage']);
    vi.mocked(systemApi.getUsers).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 2,
          username: 'employee',
          realName: '测试员工',
          status: 1,
          department: null,
          group: null,
          roles: [],
          createdAt: '2026-07-22T00:00:00Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    vi.mocked(systemApi.getDepartments).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.createDepartment).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.updateDepartment).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.deleteDepartment).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.getGroupTree).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.createGroup).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.updateGroup).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.deleteGroup).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.getRoles).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getAllUsers).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getGroups).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getPermissions).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.initPermissions).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getApprovalFlows).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getSettings).mockResolvedValue({ code: 0, data: { list: [], settings: {} } });
    vi.mocked(systemApi.updateRolePermissions).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.createRole).mockResolvedValue({ code: 0, data: { id: 8 } as any });
    vi.mocked(systemApi.createApprovalFlow).mockResolvedValue({ code: 0 } as any);
    vi.mocked(systemApi.updateApprovalFlow).mockResolvedValue({ code: 0 } as any);
    vi.mocked(systemApi.deleteApprovalFlow).mockResolvedValue({ code: 0 } as any);
    vi.mocked(systemApi.createUser).mockResolvedValue({ code: 0 } as any);
    vi.mocked(systemApi.updateUser).mockResolvedValue({ code: 0 } as any);
    vi.mocked(systemApi.deleteUser).mockResolvedValue({ code: 0 } as any);
    vi.mocked(systemApi.updateSetting).mockResolvedValue({ code: 0 });
    vi.mocked(systemApi.resetPassword).mockResolvedValue({
      code: 0,
      data: { password: 'generated-strong-password' },
    });
    vi.mocked(announcementApi.getAdminList).mockResolvedValue({
      code: 0,
      data: { list: [], total: 0, page: 1, pageSize: 20 },
    });
    vi.mocked(announcementApi.create).mockResolvedValue({ code: 0, data: { ttStatus: 'sent' } } as any);
    vi.mocked(announcementApi.update).mockResolvedValue({ code: 0 } as any);
    vi.mocked(announcementApi.delete).mockResolvedValue({ code: 0 } as any);
    vi.mocked(announcementApi.getStats).mockResolvedValue({
      code: 0,
      data: { targetCount: 0, readCount: 0, unreadCount: 0, readRate: 0, readUsers: [] },
    } as any);
    vi.mocked(auditApi.getList).mockResolvedValue({
      code: 0,
      data: { list: [], total: 0, page: 1, pageSize: 20 },
    });
  });

  it('重置密码时请求随机密码，并只在本次弹窗展示', async () => {
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: '重置密码' }));
    await user.click(await screen.findByRole('button', { name: /OK|确.*定/i }));

    await waitFor(() => expect(systemApi.resetPassword).toHaveBeenCalledWith(2));
    expect(await screen.findByText('generated-strong-password')).toBeInTheDocument();
    expect(screen.getByText(/临时密码只在本次显示/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '我已保存' }));
  });

  it('可以创建、编辑并删除用户，编辑时不会重新提交密码', async () => {
    vi.mocked(systemApi.getRoles).mockResolvedValue({
      code: 0,
      data: [{ id: 6, name: 'employee', label: '员工', permissions: [] } as any],
    });
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: /新增用户/ }));
    await user.type(screen.getByLabelText('用户名'), 'new_employee');
    await user.type(screen.getByLabelText('姓名'), '新员工');
    await user.type(screen.getByLabelText('初始密码'), 'StrongPass123');
    await user.click(screen.getByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.createUser).toHaveBeenCalledWith(expect.objectContaining({
      username: 'new_employee',
      realName: '新员工',
      password: 'StrongPass123',
    })));

    await user.click(screen.getByRole('button', { name: '编辑' }));
    const realNameInput = screen.getByLabelText('姓名');
    await user.clear(realNameInput);
    await user.type(realNameInput, '员工新姓名');
    expect(screen.queryByLabelText('初始密码')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.updateUser).toHaveBeenCalledWith(2, expect.objectContaining({
      username: 'employee',
      realName: '员工新姓名',
    })));
    expect(vi.mocked(systemApi.updateUser).mock.calls[0][1]).not.toHaveProperty('password');

    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(await screen.findByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.deleteUser).toHaveBeenCalledWith(2));
  }, 15_000);

  it('没有任何系统子模块权限时不请求后台数据，并显示空状态', () => {
    setPermissions(['system:access']);
    render(<System />);

    expect(screen.getByText('暂无可管理模块')).toBeInTheDocument();
    expect(systemApi.getUsers).not.toHaveBeenCalled();
    expect(systemApi.getDepartments).not.toHaveBeenCalled();
  });

  it('组织管理提供部门与分组的维护入口', async () => {
    setPermissions(['system:access', 'system:org:manage']);
    vi.mocked(systemApi.getDepartments).mockResolvedValue({
      code: 0,
      data: [{ id: 3, name: '研发部', description: '', leader: null } as any],
    });
    vi.mocked(systemApi.getGroupTree).mockResolvedValue({
      code: 0,
      data: [{
        id: 5,
        name: '平台组',
        departmentId: 3,
        parentId: null,
        path: '5',
        members: [],
        children: [],
      } as any],
    });
    const user = userEvent.setup();
    render(<System />);

    await screen.findByText('平台组');
    await user.click(screen.getByRole('button', { name: /新增部门/ }));
    await user.type(screen.getByLabelText('名称'), '质量部');
    await user.click(screen.getByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.createDepartment).toHaveBeenCalledWith(expect.objectContaining({ name: '质量部' })));

    await user.click(screen.getByRole('button', { name: '编辑分组平台组' }));
    const groupName = screen.getByLabelText('名称');
    await user.clear(groupName);
    await user.type(groupName, '平台工程组');
    await user.click(screen.getByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.updateGroup).toHaveBeenCalledWith(5, expect.objectContaining({ name: '平台工程组' })));
  });

  it('自定义角色可以从权限目录勾选并保存', async () => {
    setPermissions(['system:access', 'system:role:manage']);
    vi.mocked(systemApi.getRoles).mockResolvedValue({
      code: 0,
      data: [{
        id: 2,
        name: 'reviewer',
        label: '复核员',
        description: '复核工时',
        isSystem: false,
        permissions: [],
        userCount: 0,
      } as any],
    });
    vi.mocked(systemApi.getPermissions).mockResolvedValue({
      code: 0,
      data: [{
        id: 11,
        code: 'timesheet:view:self',
        name: '查看本人工时',
        description: '查看自己的工时记录',
        module: 'timesheet',
        action: 'view:self',
      } as any],
    });
    const user = userEvent.setup();
    render(<System />);

    const permissionLabel = await screen.findByText('查看本人工时');
    await user.click(permissionLabel.closest('label')!);
    await user.click(screen.getByRole('button', { name: '保存权限' }));

    await waitFor(() => expect(systemApi.updateRolePermissions).toHaveBeenCalledWith(2, [11]));
  });

  it('复制管理员角色时复制其实际拥有的全部权限', async () => {
    setPermissions(['system:access', 'system:role:manage']);
    vi.mocked(systemApi.getRoles).mockResolvedValue({
      code: 0,
      data: [{
        id: 1,
        name: 'admin',
        label: '管理员',
        description: '超级管理员',
        isSystem: true,
        permissions: [],
        userCount: 1,
      } as any],
    });
    vi.mocked(systemApi.getPermissions).mockResolvedValue({
      code: 0,
      data: [
        { id: 11, code: 'timesheet:view:self', name: '查看本人工时', module: 'timesheet', action: 'view:self' },
        { id: 12, code: 'report:view:self', name: '查看个人报表', module: 'report', action: 'view:self' },
      ] as any,
    });
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: '复制角色管理员' }));
    await user.type(screen.getByLabelText('角色标识'), 'admin_copy');
    await user.click(screen.getByRole('button', { name: '创建角色' }));

    await waitFor(() => expect(systemApi.createRole).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_copy',
      permissionIds: [11, 12],
    })));
  });

  it('审批类型只展示可用步骤，并仅在上级负责人步骤显示层级', async () => {
    setPermissions(['system:access', 'system:approval_flow:manage']);
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: /新增审批流程/ }));
    await user.click(screen.getByLabelText('适用类型'));
    await user.click(await screen.findByText('周报审批'));
    await user.click(screen.getByLabelText('步骤类型'));
    expect(screen.queryByText('模块SE')).not.toBeInTheDocument();
    expect(screen.queryByText('项目管理员')).not.toBeInTheDocument();
    await user.click(await screen.findByText('上级负责人'));
    expect(await screen.findByLabelText('上级层级')).toBeInTheDocument();
  });

  it('审批流程创建时规范化步骤字段，已有流程可以编辑和删除', async () => {
    vi.mocked(systemApi.getAllUsers).mockResolvedValue({
      code: 0,
      data: [{ id: 9, username: 'approver', realName: '指定审批人' } as any],
    });
    vi.mocked(systemApi.getApprovalFlows).mockResolvedValue({
      code: 0,
      data: [{
        id: 4,
        name: '原审批流程',
        type: 'weekly_report',
        description: '',
        isDefault: false,
        enabled: true,
        steps: [{ id: 1, stepOrder: 1, stepType: 'group_leader', label: '直属负责人审批', parentLevel: 1 }],
      } as any],
    });
    setPermissions(['system:access', 'system:approval_flow:manage']);
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: /新增审批流程/ }));
    await user.type(screen.getByLabelText('流程名称'), '指定人审批');
    await user.click(screen.getByLabelText('适用类型'));
    await user.click(await screen.findByText('权限申请审批'));
    await user.click(screen.getByLabelText('步骤类型'));
    await user.click(await screen.findByText('自定义审批人'));
    await user.click(screen.getByLabelText('审批人'));
    await user.click(await screen.findByText('指定审批人'));
    await user.click(screen.getByRole('button', { name: /OK|确.*定/i }));

    await waitFor(() => expect(systemApi.createApprovalFlow).toHaveBeenCalledWith(expect.objectContaining({
      name: '指定人审批',
      type: 'permission_request',
      steps: [expect.objectContaining({
        stepType: 'custom',
        customApproverId: 9,
        parentLevel: 1,
        requireAllApprovers: false,
      })],
    })));

    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const flowName = screen.getByLabelText('流程名称');
    await user.clear(flowName);
    await user.type(flowName, '更新后的流程');
    await user.click(screen.getByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.updateApprovalFlow).toHaveBeenCalledWith(4, expect.objectContaining({
      name: '更新后的流程',
      type: 'weekly_report',
    })));

    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(await screen.findByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(systemApi.deleteApprovalFlow).toHaveBeenCalledWith(4));
  }, 15_000);

  it('仅有权限管理权限时展示独立权限目录，且同步不会请求角色数据', async () => {
    setPermissions(['system:access', 'system:permission:manage']);
    vi.mocked(systemApi.getPermissions).mockResolvedValue({
      code: 0,
      data: [{
        id: 31,
        code: 'system:audit:view',
        name: '系统管理-审计日志查看',
        description: '查看不可修改的审计记录',
        module: 'system',
        action: 'audit:view',
      }],
    });
    vi.mocked(systemApi.initPermissions).mockResolvedValue({
      code: 0,
      data: [{
        id: 31,
        code: 'system:audit:view',
        name: '系统管理-审计日志查看',
        description: '查看不可修改的审计记录',
        module: 'system',
        action: 'audit:view',
      }],
    });
    const user = userEvent.setup();
    render(<System />);

    expect(await screen.findByText('系统管理-审计日志查看')).toBeInTheDocument();
    expect(systemApi.getRoles).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /同步系统权限目录/ }));
    await waitFor(() => expect(systemApi.initPermissions).toHaveBeenCalledTimes(1));
  });

  it('只有公告查看权限时不读取全员目录，公告列表仍可加载', async () => {
    setPermissions(['system:access', 'system:announcement:view']);
    vi.mocked(announcementApi.getAdminList).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 7,
          title: '仅查看公告',
          content: '公告正文',
          type: 'info',
          targetScope: 'all',
          createdByName: '管理员',
          createdAt: '2026-07-22T00:00:00Z',
        } as any],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });

    render(<System />);

    expect(await screen.findByText('仅查看公告')).toBeInTheDocument();
    expect(systemApi.getAllUsers).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '发布公告' })).not.toBeInTheDocument();
  });

  it('公告按用户范围发布，编辑时清理无关范围字段并支持统计与删除', async () => {
    setPermissions([
      'system:access',
      'system:announcement:view',
      'system:announcement:create',
      'system:announcement:update',
      'system:announcement:delete',
    ]);
    vi.mocked(systemApi.getAllUsers).mockResolvedValue({
      code: 0,
      data: [{ id: 8, username: 'reader', realName: '公告接收人' } as any],
    });
    vi.mocked(announcementApi.getAdminList).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 7,
          title: '原公告',
          content: '原正文',
          type: 'important',
          targetScope: 'department',
          targetDeptId: 3,
          targetGroupId: null,
          targetUserIds: null,
          createdByName: '管理员',
          createdAt: '2026-07-22T00:00:00Z',
        } as any],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    vi.mocked(announcementApi.getStats).mockResolvedValue({
      code: 0,
      data: {
        targetCount: 2,
        readCount: 1,
        unreadCount: 1,
        readRate: 50,
        readUsers: [{ userId: 8, realName: '公告接收人', readAt: '2026-07-22T01:00:00Z' }],
      },
    } as any);
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: /发布公告/ }));
    await user.type(screen.getByLabelText('标题'), '新公告');
    await user.click(screen.getByLabelText('发送范围'));
    await user.click(await screen.findByText('指定用户'));
    await user.click(screen.getByLabelText('选择用户'));
    await user.click(await screen.findByText('公告接收人'));
    await user.click(screen.getByRole('button', { name: /^发\s*布$/ }));
    await waitFor(() => expect(announcementApi.create).toHaveBeenCalledWith(expect.objectContaining({
      title: '新公告',
      targetScope: 'user',
      targetUserIds: [8],
      targetDeptId: null,
      targetGroupId: null,
    })));

    await user.click(screen.getByRole('button', { name: /编辑/ }));
    await user.click(screen.getByLabelText('发送范围'));
    await user.click(await screen.findByText('全部用户'));
    await user.click(screen.getByRole('button', { name: /^保\s*存$/ }));
    await waitFor(() => expect(announcementApi.update).toHaveBeenCalledWith(7, expect.objectContaining({
      targetScope: 'all',
      targetDeptId: null,
      targetGroupId: null,
      targetUserIds: null,
    })));

    await user.click(screen.getByRole('button', { name: /统计/ }));
    expect(await screen.findByText('公告已读统计 - 原公告')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: /删除/ }));
    await user.click(await screen.findByRole('button', { name: /OK|确.*定/i }));
    await waitFor(() => expect(announcementApi.delete).toHaveBeenCalledWith(7));
  }, 15_000);

  it('审批流程加载失败时保留错误和重试入口', async () => {
    setPermissions(['system:access', 'system:approval_flow:manage']);
    vi.mocked(systemApi.getApprovalFlows)
      .mockRejectedValueOnce({ response: { data: { message: '审批服务暂不可用' } } })
      .mockResolvedValueOnce({ code: 0, data: [] });
    const user = userEvent.setup();
    render(<System />);

    expect(await screen.findByText('审批服务暂不可用')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(systemApi.getApprovalFlows).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /新增审批流程/ })).toBeInTheDocument();
  });

  it('审计日志详情将 JSON 格式化为可读内容', async () => {
    setPermissions(['system:access', 'system:audit:view']);
    vi.mocked(auditApi.getList).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 9,
          userId: 1,
          userName: '管理员',
          action: 'role.update',
          target: 'role',
          targetId: 3,
          detail: '{"label":"复核员"}',
          ip: '127.0.0.1',
          createdAt: '2026-07-22T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    const user = userEvent.setup();
    render(<System />);

    await user.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(await screen.findByText('审计详情 #9')).toBeInTheDocument();
    expect(screen.getByText(/"label": "复核员"/)).toBeInTheDocument();
  });

  it('定时提醒读取现有配置并按完整结构保存', async () => {
    setPermissions(['system:access', 'system:settings:manage']);
    vi.mocked(systemApi.getSettings).mockResolvedValue({
      code: 0,
      data: {
        list: [],
        settings: {
          timesheet_reminder_config: JSON.stringify({
            enabled: false,
            weekdays: [5],
            time: '17:30',
            targetScope: 'all',
            message: '请填写工时',
          }),
        },
      },
    });
    const user = userEvent.setup();
    render(<System />);

    expect(await screen.findByText('请填写工时')).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: '保存提醒设置' }));

    await waitFor(() => expect(systemApi.updateSetting).toHaveBeenCalledWith(
      'timesheet_reminder_config',
      expect.stringContaining('"enabled":true'),
    ));
  });

  it('基础设置分别保存去空格的系统名、工时单位和锁定日', async () => {
    setPermissions(['system:access', 'system:settings:manage']);
    const user = userEvent.setup();
    render(<System />);

    const systemName = await screen.findByPlaceholderText('如：WorkTime');
    await user.clear(systemName);
    await user.type(systemName, '  新工时系统  ');
    const saveButtons = screen.getAllByRole('button', { name: /^保\s*存$/ });
    await user.click(saveButtons[0]);
    await waitFor(() => expect(systemApi.updateSetting).toHaveBeenCalledWith('system_name', '新工时系统'));

    await user.click(screen.getByText('0.25天'));
    await user.click(saveButtons[1]);
    await waitFor(() => expect(systemApi.updateSetting).toHaveBeenCalledWith('timesheet_unit', '0.25'));

    const lockInput = screen.getByRole('spinbutton');
    await user.clear(lockInput);
    await user.type(lockInput, '15');
    await user.click(saveButtons[2]);
    await waitFor(() => expect(systemApi.updateSetting).toHaveBeenCalledWith('timesheet_lock_day', '15'));
  });

  it('提醒配置 JSON 结构损坏时恢复安全停用值而不崩溃', async () => {
    setPermissions(['system:access', 'system:settings:manage']);
    vi.mocked(systemApi.getSettings).mockResolvedValue({
      code: 0,
      data: {
        list: [],
        settings: {
          timesheet_reminder_config: JSON.stringify({
            enabled: true,
            weekdays: null,
            time: '17:30',
            targetScope: 'all',
            message: '提醒',
          }),
        },
      },
    });

    render(<System />);

    expect(await screen.findByText(/已保存的提醒日期无效/)).toBeInTheDocument();
    expect(screen.getByText(/当前计划：停用/)).toBeInTheDocument();
  });
});
