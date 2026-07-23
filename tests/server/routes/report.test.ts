import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AccessPolicyService } from '@server/services/accessPolicyService';
import { ReportService } from '@server/services/reportService';
import { AppDataSource } from '@server/config/database';
import { createRouteTestApp } from '../helpers/http';

vi.mock('@server/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: 1, username: 'reporter', realName: '报表用户', roles: ['employee'] };
    req.userPermissions = new Set([
      'report:access', 'report:view:self', 'report:view:group',
      'report:view:department', 'report:view:project', 'report:view:overtime', 'report:export',
    ]);
    next();
  },
}));

const { reportRoutes } = await import('@server/routes/report');
const app = createRouteTestApp('/reports', reportRoutes);

describe('报表路由范围与参数校验', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(AccessPolicyService.prototype, 'hasUnrestrictedPermission').mockResolvedValue(false);
    vi.spyOn(AccessPolicyService.prototype, 'getPermissionScope').mockResolvedValue({
      unrestricted: true,
      departmentIds: [],
      groupIds: [],
      projectIds: [],
    });
  });

  it('所有报表在查询前拒绝反向日期区间', async () => {
    const service = vi.spyOn(ReportService.prototype, 'getPersonalReport');
    const response = await request(app)
      .get('/reports/personal?startDate=2026-07-31&endDate=2026-07-01');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('startDate不能晚于endDate');
    expect(service).not.toHaveBeenCalled();
  });

  it('个人报表不允许越过组织范围查看他人', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessUserData').mockResolvedValue(false);
    const service = vi.spyOn(ReportService.prototype, 'getPersonalReport');
    const response = await request(app)
      .get('/reports/personal?userId=9&startDate=2026-07-01&endDate=2026-07-31');

    expect(response.status).toBe(403);
    expect(service).not.toHaveBeenCalled();
  });

  it('组别报表包含子组，并将服务端解析的范围传入查询', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessGroup').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'getGroupAndDescendantIds').mockResolvedValue([3, 4, 5]);
    const service = vi.spyOn(ReportService.prototype, 'getGroupReport').mockResolvedValue({
      groupId: 3, totalDays: 0, byUser: {}, byProject: {}, records: [],
    } as any);

    const response = await request(app)
      .get('/reports/group?groupId=3&startDate=2026-07-01&endDate=2026-07-31');

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(3, '2026-07-01', '2026-07-31', [3, 4, 5]);
  });

  it('部门报表拒绝不属于该部门的组别', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessDepartment').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'isGroupInDepartment').mockResolvedValue(false);
    const service = vi.spyOn(ReportService.prototype, 'getDepartmentReport');
    const response = await request(app)
      .get('/reports/department?departmentId=2&groupId=8&startDate=2026-07-01&endDate=2026-07-31');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('组别不属于当前部门');
    expect(service).not.toHaveBeenCalled();
  });

  it('工作台只请求当前权限允许的汇总数据', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockImplementation(async (_viewer, code) => (
      code === 'timesheet:view:self'
    ));
    const dashboard = vi.spyOn(ReportService.prototype, 'getDashboardData').mockResolvedValue({
      monthDays: 2, overtimeDays: 0, pendingCount: 0, trend: [],
      hasTimesheetDrafts: false, weeklyReportStatus: null,
    });

    const response = await request(app).get('/reports/dashboard');
    expect(response.status).toBe(200);
    expect(dashboard).toHaveBeenCalledWith(1, {
      timesheet: true, overtime: false, approvals: false, weeklyReport: false,
    });
  });

  it('加班导出拒绝越权导出指定用户', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessUserData').mockResolvedValue(false);
    const service = vi.spyOn(ReportService.prototype, 'getOvertimeReport');

    const response = await request(app)
      .get('/reports/export/overtime?userId=9&startDate=2026-07-01&endDate=2026-07-31');

    expect(response.status).toBe(403);
    expect(response.body.message).toBe('只能导出自己或负责范围内成员的加班报表');
    expect(service).not.toHaveBeenCalled();
  });

  it('加班导出拒绝跨部门组别组合', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessDepartment').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAccessGroup').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'isGroupInDepartment').mockResolvedValue(false);
    const service = vi.spyOn(ReportService.prototype, 'getOvertimeReport');

    const response = await request(app)
      .get('/reports/export/overtime?departmentId=2&groupId=8&startDate=2026-07-01&endDate=2026-07-31');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('组别不属于当前部门');
    expect(service).not.toHaveBeenCalled();
  });

  it('全局加班范围查询显式授权服务层执行无范围汇总', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'isAdmin').mockReturnValue(false);
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(true);
    vi.mocked(AccessPolicyService.prototype.hasUnrestrictedPermission).mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'getAccessibleDepartmentIds').mockResolvedValue(null);
    vi.spyOn(AccessPolicyService.prototype, 'getAccessibleGroupIds').mockResolvedValue(null);
    vi.spyOn(AccessPolicyService.prototype, 'getAccessibleProjectIds').mockResolvedValue(null);
    const service = vi.spyOn(ReportService.prototype, 'getOvertimeReport').mockResolvedValue({
      totalDays: 0, byType: {}, byUser: {}, byGroup: {}, records: [],
    });

    const response = await request(app)
      .get('/reports/overtime?startDate=2026-07-01&endDate=2026-07-31');

    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      userId: undefined,
      allowAll: true,
    }));
  });

  it('加班报表支持项目范围，并拒绝超出项目授权的筛选', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(false);
    const accessible = vi.spyOn(AccessPolicyService.prototype, 'getAccessibleProjectIds')
      .mockResolvedValue([7]);
    const service = vi.spyOn(ReportService.prototype, 'getOvertimeReport').mockResolvedValue({
      totalDays: 1, byType: {}, byUser: {}, byGroup: {}, records: [],
    });

    const allowed = await request(app)
      .get('/reports/overtime?projectId=7&startDate=2026-07-01&endDate=2026-07-31');
    expect(allowed.status).toBe(200);
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ projectId: 7 }));

    const denied = await request(app)
      .get('/reports/overtime?projectId=8&startDate=2026-07-01&endDate=2026-07-31');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('只能查看自己负责项目的加班报表');
    expect(accessible).toHaveBeenCalled();
    expect(service).toHaveBeenCalledTimes(1);
  });

  it('范围化导出权限不能用于其他组别', async () => {
    vi.mocked(AccessPolicyService.prototype.getPermissionScope).mockResolvedValue({
      unrestricted: false,
      departmentIds: [],
      groupIds: [3, 4],
      projectIds: [],
    });
    vi.spyOn(AccessPolicyService.prototype, 'canAccessGroup').mockResolvedValue(true);
    const service = vi.spyOn(ReportService.prototype, 'getGroupReport');

    const denied = await request(app)
      .get('/reports/export/group?groupId=9&startDate=2026-07-01&endDate=2026-07-31');
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('导出权限不包含当前组别范围');
    expect(service).not.toHaveBeenCalled();
  });

  it('范围接口只返回脱敏的可见组织和项目选项', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'isAdmin').mockReturnValue(false);
    vi.spyOn(AccessPolicyService.prototype, 'getVisibleDepartments').mockResolvedValue([{
      id: 2, name: '研发部', leaderId: 8,
      leader: { id: 8, realName: '部门负责人', password: 'secret' },
    }] as any);
    vi.spyOn(AccessPolicyService.prototype, 'getVisibleGroups').mockResolvedValue([{
      id: 3, name: '平台组', departmentId: 2, parentId: null, level: 1, leaderId: 9,
      leader: { id: 9, realName: '组长', password: 'secret' },
      parent: null, department: { id: 2, name: '研发部', description: '内部信息' },
    }] as any);
    vi.spyOn(AccessPolicyService.prototype, 'getVisibleReportProjects').mockResolvedValue([{
      id: 4, name: '工时系统', code: 'WT',
      managers: [{ id: 10, realName: '项目经理', password: 'secret' }],
      moduleSEs: [{
        id: 11, projectId: 4, userId: 12, groupId: 3,
        user: { id: 12, realName: '模块SE', password: 'secret' },
        group: { id: 3, name: '平台组', departmentId: 2, department: { id: 2, name: '研发部' } },
      }],
    }] as any);
    vi.spyOn(AccessPolicyService.prototype, 'getVisibleProjectsForPermissions').mockResolvedValue([{
      id: 4, name: '工时系统', code: 'WT', status: 'active',
    }] as any);

    const response = await request(app).get('/reports/scope');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      canViewPersonal: true,
      canViewDepartment: true,
      canViewGroup: true,
      canViewProject: true,
      canViewOvertime: true,
      departments: [{ id: 2, name: '研发部', leader: { id: 8, realName: '部门负责人' } }],
      projects: [{ id: 4, managers: [{ id: 10, realName: '项目经理' }] }],
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('个人、部门和项目报表成功路径传递服务端解析的筛选条件', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessUserData').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAccessDepartment').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'isGroupInDepartment').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAccessProjectReport').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'getGroupAndDescendantIds').mockResolvedValue([6, 7]);
    const personal = vi.spyOn(ReportService.prototype, 'getPersonalReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    const department = vi.spyOn(ReportService.prototype, 'getDepartmentReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    const project = vi.spyOn(ReportService.prototype, 'getProjectReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      createQueryBuilder: vi.fn(() => {
        const qb: any = {
          select: vi.fn(() => qb), where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
          groupBy: vi.fn(() => qb), addGroupBy: vi.fn(() => qb),
          getRawMany: vi.fn().mockResolvedValue([
            { departmentId: 2, departmentName: '研发部', groupId: 6, groupName: '平台组' },
          ]),
        };
        return qb;
      }),
    } as any);

    expect((await request(app).get('/reports/personal?userId=5&startDate=2026-07-01&endDate=2026-07-31')).status).toBe(200);
    expect(personal).toHaveBeenCalledWith(5, '2026-07-01', '2026-07-31');

    expect((await request(app).get('/reports/department?departmentId=2&groupId=6&startDate=2026-07-01&endDate=2026-07-31')).status).toBe(200);
    expect(department).toHaveBeenCalledWith(2, '2026-07-01', '2026-07-31', { groupId: 6, groupIds: [6, 7] });

    const projectResponse = await request(app).get('/reports/project?projectId=4&departmentId=2&groupId=6&startDate=2026-07-01&endDate=2026-07-31');
    expect(projectResponse.status).toBe(200);
    expect(project).toHaveBeenCalledWith(4, '2026-07-01', '2026-07-31', {
      departmentId: 2, departmentIds: undefined, groupId: 6, groupIds: [6, 7],
    });
    expect(projectResponse.body.data.filters).toEqual({
      departments: [{ id: 2, name: '研发部' }],
      groups: [{ id: 6, name: '平台组', departmentId: 2 }],
    });
  });

  it('五类导出均生成 xlsx，且查询范围先经过服务端授权', async () => {
    vi.spyOn(AccessPolicyService.prototype, 'canAccessUserData').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAccessDepartment').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAccessGroup').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'canAccessProjectReport').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'isGroupInDepartment').mockResolvedValue(true);
    vi.spyOn(AccessPolicyService.prototype, 'getGroupAndDescendantIds').mockResolvedValue([3]);
    vi.spyOn(AccessPolicyService.prototype, 'getAccessibleProjectIds').mockResolvedValue(null);
    vi.spyOn(AccessPolicyService.prototype, 'isAdmin').mockReturnValue(true);
    vi.spyOn(ReportService.prototype, 'getPersonalReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    vi.spyOn(ReportService.prototype, 'getDepartmentReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    vi.spyOn(ReportService.prototype, 'getGroupReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    vi.spyOn(ReportService.prototype, 'getProjectReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    vi.spyOn(ReportService.prototype, 'getOvertimeReport').mockResolvedValue({ records: [], totalDays: 0 } as any);
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      createQueryBuilder: vi.fn(() => {
        const qb: any = {
          select: vi.fn(() => qb), where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
          groupBy: vi.fn(() => qb), addGroupBy: vi.fn(() => qb), getRawMany: vi.fn().mockResolvedValue([]),
        };
        return qb;
      }),
    } as any);
    const dateQuery = 'startDate=2026-07-01&endDate=2026-07-31';
    const urls = [
      `/reports/export/personal?${dateQuery}`,
      `/reports/export/department?departmentId=2&${dateQuery}`,
      `/reports/export/group?groupId=3&${dateQuery}`,
      `/reports/export/project?projectId=4&${dateQuery}`,
      `/reports/export/overtime?${dateQuery}`,
    ];
    for (const url of urls) {
      const response = await request(app).get(url).buffer(true);
      expect(response.status, url).toBe(200);
      expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(response.headers['content-disposition']).toContain('.xlsx');
    }
  });
});
