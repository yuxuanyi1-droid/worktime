import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({
  get: vi.fn(async () => ({ code: 0 })),
  post: vi.fn(async () => ({ code: 0 })),
  put: vi.fn(async () => ({ code: 0 })),
  patch: vi.fn(async () => ({ code: 0 })),
  delete: vi.fn(async () => ({ code: 0 })),
}));

vi.mock('@client/utils/request', () => ({ default: request }));

import { agentApi } from '@client/api/agent';
import { approvalApi } from '@client/api/approval';
import { auditApi } from '@client/api/audit';
import { authApi } from '@client/api/auth';
import {
  announcementApi,
  emitNotificationReadStateChanged,
  NOTIFICATION_READ_STATE_EVENT,
  notificationApi,
} from '@client/api/notification';
import { overtimeApi } from '@client/api/overtime';
import { patApi } from '@client/api/pat';
import { permissionRequestApi } from '@client/api/permissionRequest';
import { reportApi } from '@client/api/report';
import { systemApi } from '@client/api/system';
import { timesheetApi } from '@client/api/timesheet';
import { weeklyReportApi } from '@client/api/weeklyReport';

type Method = keyof typeof request;

async function expectCall(run: () => unknown, method: Method, ...args: unknown[]) {
  request[method].mockClear();
  await run();
  expect(request[method]).toHaveBeenCalledOnce();
  expect(request[method]).toHaveBeenCalledWith(...args);
}

describe('客户端 API 契约', () => {
  it('认证与 OIDC 接口的方法、路径和编码保持一致', async () => {
    const login = { username: 'user', password: 'password' };
    await expectCall(() => authApi.login(login), 'post', '/auth/login', login);
    await expectCall(() => authApi.logout(), 'post', '/auth/logout');
    await expectCall(() => authApi.getProfile(), 'get', '/auth/profile');
    const profile = { realName: '新姓名', email: 'new@example.com', phone: '13800138000' };
    await expectCall(() => authApi.updateProfile(profile), 'put', '/auth/profile', profile);
    await expectCall(() => authApi.changePassword({ oldPassword: 'old', newPassword: 'new' }), 'put',
      '/auth/change-password', { oldPassword: 'old', newPassword: 'new' });
    await expectCall(() => authApi.oidcVisibleProviders(), 'get', '/auth/oidc/providers');
    await expectCall(() => authApi.oidcLogin('corp/idp', { redirect: '/home' }), 'get',
      '/auth/oidc/corp%2Fidp/login', { params: { redirect: '/home' } });
    await expectCall(() => authApi.oidcCallback('corp/idp', { code: 'c', state: 's' }), 'post',
      '/auth/oidc/corp%2Fidp/callback', { code: 'c', state: 's' });
    await expectCall(() => authApi.oidcBindings(), 'get', '/auth/oidc/bindings');
    await expectCall(() => authApi.oidcUnbind('corp/idp'), 'delete', '/auth/oidc/bindings/corp%2Fidp');
  });

  it('AI 会话接口对动态会话 ID 编码并携带操作参数', async () => {
    await expectCall(() => agentApi.getStatus(), 'get', '/agent/status');
    await expectCall(() => agentApi.getSessions(), 'get', '/agent/sessions');
    await expectCall(() => agentApi.createSession(), 'post', '/agent/sessions');
    await expectCall(() => agentApi.getHistory('session/a'), 'get', '/agent/sessions/session%2Fa/messages');
    await expectCall(() => agentApi.renameSession('session/a', '新名称'), 'patch',
      '/agent/sessions/session%2Fa', { title: '新名称' });
    await expectCall(() => agentApi.deleteSession('session/a'), 'delete', '/agent/sessions/session%2Fa');
    await expectCall(() => agentApi.abortSession('session/a'), 'post', '/agent/sessions/session%2Fa/abort');
    await expectCall(() => agentApi.queueMessage('session/a', '继续'), 'post',
      '/agent/sessions/session%2Fa/queue', { message: '继续', mode: 'followUp' });
    await expectCall(() => agentApi.queueMessage('session/a', '调整', 'steer'), 'post',
      '/agent/sessions/session%2Fa/queue', { message: '调整', mode: 'steer' });
  });

  it('审批接口覆盖待办、历史、详情、撤回、抄送和我的提交', async () => {
    const params = { page: 2 };
    await expectCall(() => approvalApi.getPending(params), 'get', '/approvals/pending', { params });
    const items = [{ targetType: 'timesheet', targetId: 1, action: 'approve' as const }];
    await expectCall(() => approvalApi.approve(items), 'post', '/approvals/approve', { items });
    await expectCall(() => approvalApi.getHistory(params), 'get', '/approvals/history', { params });
    await expectCall(() => approvalApi.getMySubmissions(params), 'get', '/approvals/my-submissions', { params });
    await expectCall(() => approvalApi.getDetail('timesheet', 3), 'get', '/approvals/detail/timesheet/3');
    await expectCall(() => approvalApi.withdraw('timesheet', 3), 'post', '/approvals/withdraw',
      { targetType: 'timesheet', targetId: 3 });
    await expectCall(() => approvalApi.cc('timesheet', 3, [7, 8]), 'post', '/approvals/cc',
      { targetType: 'timesheet', targetId: 3, recipientIds: [7, 8] });
    await expectCall(() => approvalApi.getUsers(), 'get', '/approvals/users');
    await expectCall(() => approvalApi.getMyCc(params), 'get', '/approvals/my-cc', { params });
  });

  it('通知与公告接口区分管理端和用户端资源', async () => {
    const params = { page: 1 };
    await expectCall(() => notificationApi.getList(params), 'get', '/notifications', { params });
    await expectCall(() => notificationApi.getUnreadCount(), 'get', '/notifications/unread-count');
    await expectCall(() => notificationApi.markAsRead([1, 2]), 'put', '/notifications/read', { ids: [1, 2] });
    await expectCall(() => notificationApi.markAllAsRead(), 'put', '/notifications/read-all');
    await expectCall(() => notificationApi.delete(4), 'delete', '/notifications/4');

    const data = { title: '公告' };
    await expectCall(() => announcementApi.getAdminList(params), 'get', '/announcements/admin/list', { params });
    await expectCall(() => announcementApi.create(data), 'post', '/announcements/admin', data);
    await expectCall(() => announcementApi.update(5, data), 'put', '/announcements/admin/5', data);
    await expectCall(() => announcementApi.delete(5), 'delete', '/announcements/admin/5');
    await expectCall(() => announcementApi.getStats(5), 'get', '/announcements/admin/5/stats');
    await expectCall(() => announcementApi.getMyList(params), 'get', '/announcements/my', { params });
    await expectCall(() => announcementApi.getMyUnreadCount(), 'get', '/announcements/my/unread-count');
    await expectCall(() => announcementApi.markAsRead(5), 'put', '/announcements/my/read/5');
    await expectCall(() => announcementApi.markAllAsRead(), 'put', '/announcements/my/read-all');

    const listener = vi.fn();
    window.addEventListener(NOTIFICATION_READ_STATE_EVENT, listener, { once: true });
    emitNotificationReadStateChanged();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('工时、加班和周报写操作使用与后端一致的批量载荷', async () => {
    const params = { status: 'draft' };
    await expectCall(() => timesheetApi.getMy(params), 'get', '/timesheets/my', { params });
    await expectCall(() => timesheetApi.getWeeklySummary('2026-07-20', '2026-07-26', 8), 'get',
      '/timesheets/weekly-summary', { params: { weekStart: '2026-07-20', weekEnd: '2026-07-26', userId: 8 } });
    await expectCall(() => timesheetApi.create({ days: 1 }), 'post', '/timesheets', { days: 1 });
    await expectCall(() => timesheetApi.batchCreate([{ days: 1 }]), 'post', '/timesheets/batch', { items: [{ days: 1 }] });
    await expectCall(() => timesheetApi.replaceWeekDrafts('2026-07-20', [{ days: 1 }]), 'post',
      '/timesheets/drafts/replace', { weekStart: '2026-07-20', items: [{ days: 1 }] });
    await expectCall(() => timesheetApi.update(2, { days: 0.5 }), 'put', '/timesheets/2', { days: 0.5 });
    await expectCall(() => timesheetApi.delete(2), 'delete', '/timesheets/2');
    await expectCall(() => timesheetApi.submit([1, 2]), 'post', '/timesheets/submit', { ids: [1, 2] });
    await expectCall(() => timesheetApi.submitByRows([{ id: 1 }]), 'post', '/timesheets/submit-rows', { rows: [{ id: 1 }] });
    await expectCall(() => timesheetApi.modifySubmitted([{ id: 1 }]), 'post', '/timesheets/modify', { rows: [{ id: 1 }] });

    await expectCall(() => overtimeApi.getMy(params), 'get', '/overtime/my', { params });
    await expectCall(() => overtimeApi.getStats(2026, 7), 'get', '/overtime/stats', { params: { year: 2026, month: 7 } });
    await expectCall(() => overtimeApi.create({ days: 1 }), 'post', '/overtime', { days: 1 });
    await expectCall(() => overtimeApi.createAndSubmit({ days: 1 }), 'post', '/overtime/submit-new', { days: 1 });
    await expectCall(() => overtimeApi.update(3, { days: 0.5 }), 'put', '/overtime/3', { days: 0.5 });
    await expectCall(() => overtimeApi.delete(3), 'delete', '/overtime/3');
    await expectCall(() => overtimeApi.submit([3]), 'post', '/overtime/submit', { ids: [3] });

    await expectCall(() => weeklyReportApi.getMy(params), 'get', '/weekly-reports/my', { params });
    await expectCall(() => weeklyReportApi.getByWeek('2026-07-20'), 'get', '/weekly-reports/week',
      { params: { weekStart: '2026-07-20' } });
    await expectCall(() => weeklyReportApi.save({ content: '周报' }), 'post', '/weekly-reports', { content: '周报' });
    await expectCall(() => weeklyReportApi.submit(6), 'post', '/weekly-reports/submit', { id: 6 });
  });

  it('权限申请、PAT、审计和报表接口正确透传筛选范围', async () => {
    const params = { page: 1 };
    await expectCall(() => permissionRequestApi.getGrantablePermissions(), 'get', '/permission-requests/grantable-permissions');
    await expectCall(() => permissionRequestApi.getMyRequests(params), 'get', '/permission-requests/my', { params });
    await expectCall(() => permissionRequestApi.getAllRequests(params), 'get', '/permission-requests/all', { params });
    const grantData = { permissionCode: 'report:view', scopeType: 'department', scopeId: 2, reason: '工作需要' };
    await expectCall(() => permissionRequestApi.create(grantData), 'post', '/permission-requests', grantData);
    await expectCall(() => permissionRequestApi.withdraw(5), 'post', '/permission-requests/5/withdraw');
    await expectCall(() => permissionRequestApi.getGrants(params), 'get', '/permission-requests/grants', { params });
    await expectCall(() => permissionRequestApi.getUsers(), 'get', '/permission-requests/users');
    await expectCall(() => permissionRequestApi.revokeGrant(7, '职责调整'), 'post',
      '/permission-requests/grants/7/revoke', { reason: '职责调整' });

    await expectCall(() => patApi.list(), 'get', '/pats');
    await expectCall(() => patApi.create({ name: 'MCP' }), 'post', '/pats', { name: 'MCP' });
    await expectCall(() => patApi.remove(3), 'delete', '/pats/3');
    await expectCall(() => auditApi.getList(params), 'get', '/audit-logs', { params });

    await expectCall(() => reportApi.getDashboard(), 'get', '/reports/dashboard');
    await expectCall(() => reportApi.getScope(), 'get', '/reports/scope');
    await expectCall(() => reportApi.getPersonal('2026-07-01', '2026-07-31', 2), 'get', '/reports/personal',
      { params: { startDate: '2026-07-01', endDate: '2026-07-31', userId: 2 } });
    await expectCall(() => reportApi.getGroup(3, '2026-07-01', '2026-07-31'), 'get', '/reports/group',
      { params: { groupId: 3, startDate: '2026-07-01', endDate: '2026-07-31' } });
    await expectCall(() => reportApi.getDepartment(4, '2026-07-01', '2026-07-31', 3), 'get', '/reports/department',
      { params: { departmentId: 4, startDate: '2026-07-01', endDate: '2026-07-31', groupId: 3 } });
    await expectCall(() => reportApi.getProject(5, '2026-07-01', '2026-07-31', { groupId: 3 }), 'get', '/reports/project',
      { params: { projectId: 5, startDate: '2026-07-01', endDate: '2026-07-31', groupId: 3 } });
    await expectCall(() => reportApi.getOvertime(params), 'get', '/reports/overtime', { params });
  });

  it('系统管理接口覆盖组织、用户、角色、项目、流程与设置', async () => {
    const data = { name: '名称' };
    const params = { departmentId: 2 };
    await expectCall(() => systemApi.getDepartments(), 'get', '/system/departments');
    await expectCall(() => systemApi.createDepartment(data), 'post', '/system/departments', data);
    await expectCall(() => systemApi.updateDepartment(2, data), 'put', '/system/departments/2', data);
    await expectCall(() => systemApi.deleteDepartment(2), 'delete', '/system/departments/2');
    await expectCall(() => systemApi.getGroupTree(2), 'get', '/system/groups/tree', { params: { departmentId: 2 } });
    await expectCall(() => systemApi.getGroups(params), 'get', '/system/groups', { params });
    await expectCall(() => systemApi.createGroup(data), 'post', '/system/groups', data);
    await expectCall(() => systemApi.updateGroup(3, data), 'put', '/system/groups/3', data);
    await expectCall(() => systemApi.deleteGroup(3), 'delete', '/system/groups/3');
    await expectCall(() => systemApi.getUsers(params), 'get', '/system/users', { params });
    await expectCall(() => systemApi.getAllUsers(), 'get', '/system/users/all');
    await expectCall(() => systemApi.createUser(data), 'post', '/system/users', data);
    await expectCall(() => systemApi.updateUser(4, data), 'put', '/system/users/4', data);
    await expectCall(() => systemApi.deleteUser(4), 'delete', '/system/users/4');
    await expectCall(() => systemApi.resetPassword(4), 'put', '/system/users/4/reset-password', {});
    await expectCall(() => systemApi.resetPassword(4, 'new-password'), 'put', '/system/users/4/reset-password', { password: 'new-password' });
    await expectCall(() => systemApi.getRoles(), 'get', '/system/roles');
    const role = { name: 'reviewer', label: '复核员', permissionIds: [1] };
    await expectCall(() => systemApi.createRole(role), 'post', '/system/roles', role);
    await expectCall(() => systemApi.updateRole(5, { label: '复核' }), 'put', '/system/roles/5', { label: '复核' });
    await expectCall(() => systemApi.deleteRole(5), 'delete', '/system/roles/5');
    await expectCall(() => systemApi.updateRolePermissions(5, [1, 2]), 'put', '/system/roles/5/permissions', { permissionIds: [1, 2] });
    await expectCall(() => systemApi.getPermissions(), 'get', '/system/permissions');
    await expectCall(() => systemApi.initPermissions(), 'post', '/system/permissions/init');
    await expectCall(() => systemApi.getProjects(), 'get', '/system/projects');
    await expectCall(() => systemApi.getActiveProjects(), 'get', '/system/projects/active');
    await expectCall(() => systemApi.getMyProjects(), 'get', '/system/projects/my');
    await expectCall(() => systemApi.canViewProjects(), 'get', '/system/projects/can-view');
    await expectCall(() => systemApi.createProject(data), 'post', '/system/projects', data);
    await expectCall(() => systemApi.updateProject(6, data), 'put', '/system/projects/6', data);
    await expectCall(() => systemApi.deleteProject(6), 'delete', '/system/projects/6');
    await expectCall(() => systemApi.getProjectSEs(6), 'get', '/system/projects/6/ses');
    await expectCall(() => systemApi.addProjectSE(6, { userId: 1, groupId: 2 }), 'post',
      '/system/projects/6/ses', { userId: 1, groupId: 2 });
    await expectCall(() => systemApi.removeProjectSE(8), 'delete', '/system/projects/ses/8');
    await expectCall(() => systemApi.getProjectAllocations(6), 'get', '/system/projects/6/allocations');
    await expectCall(() => systemApi.addProjectAllocation(6, { groupId: 2, allocation: 10 }), 'post',
      '/system/projects/6/allocations', { groupId: 2, allocation: 10 });
    await expectCall(() => systemApi.removeProjectAllocation(9), 'delete', '/system/projects/allocations/9');
    await expectCall(() => systemApi.getApprovalFlows('timesheet'), 'get', '/system/approval-flows', { params: { type: 'timesheet' } });
    await expectCall(() => systemApi.getApprovalFlow(7), 'get', '/system/approval-flows/7');
    await expectCall(() => systemApi.createApprovalFlow(data), 'post', '/system/approval-flows', data);
    await expectCall(() => systemApi.updateApprovalFlow(7, data), 'put', '/system/approval-flows/7', data);
    await expectCall(() => systemApi.deleteApprovalFlow(7), 'delete', '/system/approval-flows/7');
    await expectCall(() => systemApi.getSettings(), 'get', '/system/settings');
    await expectCall(() => systemApi.updateSetting('system_name', 'WorkTime'), 'put',
      '/system/settings/system_name', { value: 'WorkTime' });
  });
});
