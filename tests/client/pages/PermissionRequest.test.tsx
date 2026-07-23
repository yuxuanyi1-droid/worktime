import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import PermissionRequestPage from '@client/pages/PermissionRequest';
import { permissionRequestApi } from '@client/api/permissionRequest';
import { systemApi } from '@client/api/system';
import { useAuthStore } from '@client/stores/authStore';

vi.mock('@client/api/permissionRequest', () => ({
  permissionRequestApi: {
    getGrantablePermissions: vi.fn(),
    getMyRequests: vi.fn(),
    getAllRequests: vi.fn(),
    create: vi.fn(),
    withdraw: vi.fn(),
    getGrants: vi.fn(),
    getUsers: vi.fn(),
    revokeGrant: vi.fn(),
  },
}));

vi.mock('@client/api/system', () => ({
  systemApi: {
    getDepartments: vi.fn(),
    getGroups: vi.fn(),
    getActiveProjects: vi.fn(),
  },
}));

function setPermissions(permissions: string[]) {
  useAuthStore.setState({
    token: 'token',
    user: {
      id: 1,
      username: 'tester',
      realName: '测试用户',
      department: null,
      group: null,
      roles: [],
      permissions,
    },
  });
}

function renderPage() {
  return render(<MemoryRouter><PermissionRequestPage /></MemoryRouter>);
}

describe('权限申请页面', () => {
  beforeEach(() => {
    vi.mocked(permissionRequestApi.getGrantablePermissions).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(permissionRequestApi.getMyRequests).mockResolvedValue({
      code: 0,
      data: { list: [], total: 0, page: 1, pageSize: 20 },
    });
    vi.mocked(permissionRequestApi.getAllRequests).mockResolvedValue({
      code: 0,
      data: { list: [], total: 0, page: 1, pageSize: 20 },
    });
    vi.mocked(permissionRequestApi.getGrants).mockResolvedValue({
      code: 0,
      data: { list: [], total: 0, page: 1, pageSize: 20 },
    });
    vi.mocked(permissionRequestApi.getUsers).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(permissionRequestApi.create).mockResolvedValue({ code: 0, data: {} as any });
    vi.mocked(permissionRequestApi.withdraw).mockResolvedValue({ code: 0, data: {} as any });
    vi.mocked(permissionRequestApi.revokeGrant).mockResolvedValue({ code: 0, data: {} as any });
    vi.mocked(systemApi.getDepartments).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getGroups).mockResolvedValue({ code: 0, data: [] });
    vi.mocked(systemApi.getActiveProjects).mockResolvedValue({ code: 0, data: [] });
  });

  it('只展示当前角色真正拥有的操作页签，不发起无权限接口请求', async () => {
    setPermissions(['permission_request:access', 'permission_request:view:self']);
    renderPage();

    expect(await screen.findByRole('tab', { name: '我的申请' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '申请开通' })).not.toBeInTheDocument();
    await waitFor(() => expect(permissionRequestApi.getMyRequests).toHaveBeenCalledWith({ page: 1, pageSize: 20 }));
    expect(permissionRequestApi.getGrantablePermissions).not.toHaveBeenCalled();
    expect(permissionRequestApi.getAllRequests).not.toHaveBeenCalled();
    expect(permissionRequestApi.getGrants).not.toHaveBeenCalled();
  });

  it('只有提交权限时显示申请表，但不擅自加载“我的申请”', async () => {
    setPermissions(['permission_request:access', 'permission_request:create']);
    renderPage();

    expect(await screen.findByRole('tab', { name: '申请开通' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '我的申请' })).not.toBeInTheDocument();
    await waitFor(() => expect(permissionRequestApi.getGrantablePermissions).toHaveBeenCalledTimes(1));
    expect(permissionRequestApi.getMyRequests).not.toHaveBeenCalled();
  });

  it('申请列表使用服务端分页，不会在 100 条处截断', async () => {
    setPermissions(['permission_request:access', 'permission_request:view:self']);
    vi.mocked(permissionRequestApi.getMyRequests)
      .mockResolvedValueOnce({
        code: 0,
        data: { list: [], total: 45, page: 1, pageSize: 20 },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { list: [], total: 45, page: 2, pageSize: 20 },
      });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(permissionRequestApi.getMyRequests).toHaveBeenCalledWith({ page: 1, pageSize: 20 }));
    await user.click(await screen.findByTitle('2'));
    await waitFor(() => expect(permissionRequestApi.getMyRequests).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 }));
  });

  it('只有入口权限时明确提示尚未配置操作权限', async () => {
    setPermissions(['permission_request:access']);
    renderPage();

    expect(await screen.findByText('当前角色尚未配置权限申请相关操作权限')).toBeInTheDocument();
    expect(permissionRequestApi.getMyRequests).not.toHaveBeenCalled();
    expect(permissionRequestApi.getGrantablePermissions).not.toHaveBeenCalled();
  });

  it('授权管理员会加载权限名称，但不会请求申请表专用的组织范围数据', async () => {
    setPermissions(['permission_request:access', 'permission_grant:manage']);
    vi.mocked(permissionRequestApi.getGrantablePermissions).mockResolvedValue({
      code: 0,
      data: [{
        id: 5,
        code: 'report:view:all',
        name: '报表中心-全局报表',
        module: 'report',
        action: 'view:all',
        grantable: true,
        scopeTypes: ['global'],
      }],
    });
    vi.mocked(permissionRequestApi.getGrants).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 21,
          userId: 8,
          user: { id: 8, realName: '授权用户', username: 'grant-user' },
          permissionCode: 'report:view:all',
          scopeType: 'global',
          source: 'request',
          status: 'active',
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(permissionRequestApi.getGrantablePermissions).toHaveBeenCalledOnce());
    expect(systemApi.getDepartments).not.toHaveBeenCalled();
    expect(systemApi.getGroups).not.toHaveBeenCalled();
    expect(systemApi.getActiveProjects).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: '授权管理' }));
    expect(await screen.findByText('报表中心-全局报表')).toBeInTheDocument();
    expect(screen.getAllByText('授权用户').length).toBeGreaterThan(1);
  });

  it('审批中的本人申请可撤回，并在完成后刷新当前页', async () => {
    setPermissions(['permission_request:access', 'permission_request:view:self', 'permission_request:create']);
    vi.mocked(permissionRequestApi.getMyRequests).mockResolvedValue({
      code: 0,
      data: {
        list: [{
          id: 31,
          applicantId: 1,
          permissionCode: 'report:view:all',
          permissionName: '报表中心-全局报表',
          scopeType: 'global',
          reason: '工作需要',
          status: 'submitted',
          currentStep: 1,
          totalSteps: 2,
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: '我的申请' }));
    await user.click(await screen.findByRole('button', { name: /撤回/ }));
    const confirm = document.querySelector('.ant-popconfirm-buttons .ant-btn-primary');
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);

    await waitFor(() => expect(permissionRequestApi.withdraw).toHaveBeenCalledWith(31));
    await waitFor(() => expect(permissionRequestApi.getMyRequests).toHaveBeenCalledTimes(2));
  });
});
