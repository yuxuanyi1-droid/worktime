import { Router } from 'express';
import ExcelJS from 'exceljs';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { ReportDefinition, ReportDefinitionScope } from '../entities/ReportDefinition';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireAllPermissions, requirePermission } from '../middleware/permission';
import { AccessPolicyService } from '../services/accessPolicyService';
import { ReportService } from '../services/reportService';
import { ReportQueryEngine, validateReportQueryConfig } from '../services/reportQueryEngine';
import { AuditService } from '../services/auditService';
import { BusinessError } from '../utils/errors';
import {
  assertDateRange,
  firstQueryValue,
  parseDateString,
  parseEnum,
  parseOptionalPositiveInt,
  parsePositiveInt,
  parseString,
} from '../utils/validation';

const router = Router();
const reportService = new ReportService();
const accessPolicy = new AccessPolicyService();
const reportEngine = new ReportQueryEngine();
const auditService = new AuditService();
const timesheetRepo = () => AppDataSource.getRepository(Timesheet);
const reportDefinitionRepo = () => AppDataSource.getRepository(ReportDefinition);

const REPORT_DEFINITION_SCOPES = ['private', 'group', 'department', 'public'] as const;

type Viewer = NonNullable<AuthRequest['user']>;

function parseReportDateRange(query: { startDate?: unknown; endDate?: unknown }) {
  const startDate = parseDateString(firstQueryValue(query.startDate), 'startDate');
  const endDate = parseDateString(firstQueryValue(query.endDate), 'endDate');
  assertDateRange(startDate, endDate);
  return { startDate, endDate };
}

async function getProjectFilterOptions(projectId: number) {
  const records = await timesheetRepo().createQueryBuilder('t')
    .select([
      't.departmentSnapshotId AS departmentId',
      't.departmentSnapshotName AS departmentName',
      't.groupSnapshotId AS groupId',
      't.groupSnapshotName AS groupName',
    ])
    .where('t.projectId = :projectId', { projectId })
    .andWhere('t.status = :status', { status: 'approved' })
    .groupBy('t.departmentSnapshotId')
    .addGroupBy('t.departmentSnapshotName')
    .addGroupBy('t.groupSnapshotId')
    .addGroupBy('t.groupSnapshotName')
    .getRawMany<{
      departmentId: number | null;
      departmentName: string | null;
      groupId: number | null;
      groupName: string | null;
    }>();

  const departments = new Map<number, { id: number; name: string }>();
  const groups = new Map<number, { id: number; name: string; departmentId: number | null }>();

  for (const record of records) {
    if (record.departmentId) {
      departments.set(Number(record.departmentId), {
        id: Number(record.departmentId),
        name: record.departmentName || '-',
      });
    }
    if (record.groupId) {
      groups.set(Number(record.groupId), {
        id: Number(record.groupId),
        name: record.groupName || '-',
        departmentId: record.departmentId ? Number(record.departmentId) : null,
      });
    }
  }

  return {
    departments: Array.from(departments.values()),
    groups: Array.from(groups.values()),
  };
}

async function getProjectScopedFilters(projectId: number, requestedDepartmentId?: number, requestedGroupId?: number) {
  const filters = await getProjectFilterOptions(projectId);
  const projectDepartmentIds = filters.departments.map((department) => department.id);

  if (requestedDepartmentId && !projectDepartmentIds.includes(requestedDepartmentId)) {
    throw new BusinessError('部门不属于当前项目报表范围');
  }
  if (requestedGroupId) {
    const group = filters.groups.find((item) => item.id === requestedGroupId);
    if (!group) throw new BusinessError('组别不属于当前项目报表范围');
    if (requestedDepartmentId && group.departmentId !== requestedDepartmentId) {
      throw new BusinessError('组别不属于当前部门');
    }
  }

  return {
    filters,
    reportFilters: {
      departmentId: requestedDepartmentId,
      departmentIds: requestedDepartmentId ? undefined : projectDepartmentIds,
      groupId: requestedGroupId,
      groupIds: requestedGroupId ? await accessPolicy.getGroupAndDescendantIds([requestedGroupId]) : undefined,
    },
  };
}

function serializeDepartments(departments: Awaited<ReturnType<AccessPolicyService['getVisibleDepartments']>>) {
  return departments.map((department) => ({
    id: department.id,
    name: department.name,
    leaderId: department.leaderId,
    leader: department.leader ? { id: department.leader.id, realName: department.leader.realName } : null,
  }));
}

function serializeGroups(groups: Awaited<ReturnType<AccessPolicyService['getVisibleGroups']>>) {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    departmentId: group.departmentId,
    parentId: group.parentId,
    level: group.level,
    leaderId: group.leaderId,
    leader: group.leader ? { id: group.leader.id, realName: group.leader.realName } : null,
    parent: group.parent ? { id: group.parent.id, name: group.parent.name } : null,
    department: group.department ? { id: group.department.id, name: group.department.name } : null,
  }));
}

function serializeProjects(projects: Awaited<ReturnType<AccessPolicyService['getVisibleProjects']>>) {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    code: project.code,
    managers: (project.managers || []).map((manager) => ({ id: manager.id, realName: manager.realName })),
    moduleSEs: (project.moduleSEs || []).map((se) => ({
      id: se.id,
      projectId: se.projectId,
      userId: se.userId,
      groupId: se.groupId,
      userName: se.userName,
      groupName: se.groupName,
      user: se.user ? { id: se.user.id, realName: se.user.realName } : null,
      group: se.group ? {
        id: se.group.id,
        name: se.group.name,
        departmentId: se.group.departmentId,
        department: se.group.department ? { id: se.group.department.id, name: se.group.department.name } : null,
      } : null,
    })),
  }));
}

async function canExportScope(
  viewer: Viewer,
  scope: { departmentId?: number; groupId?: number; projectId?: number } = {},
) {
  const exportScope = await accessPolicy.getPermissionScope(viewer, 'report:export');
  if (exportScope.unrestricted) return true;
  if (scope.groupId && exportScope.groupIds.includes(scope.groupId)) return true;
  if (scope.departmentId && exportScope.departmentIds.includes(scope.departmentId)) return true;
  if (scope.projectId && exportScope.projectIds.includes(scope.projectId)) return true;
  return false;
}

router.use(authMiddleware);

router.get('/scope', requirePermission('report:access'), async (req: AuthRequest, res, next) => {
  try {
    const viewer = req.user!;
    const [
      canPersonal,
      canGroupPermission,
      canDepartmentPermission,
      canProjectPermission,
      canOvertimePermission,
      canAllReports,
      canExportPermission,
    ] = await Promise.all([
      accessPolicy.hasPermission(viewer, 'report:view:self'),
      accessPolicy.hasPermission(viewer, 'report:view:group'),
      accessPolicy.hasPermission(viewer, 'report:view:department'),
      accessPolicy.hasPermission(viewer, 'report:view:project'),
      accessPolicy.hasPermission(viewer, 'report:view:overtime'),
      accessPolicy.hasUnrestrictedPermission(viewer, 'report:view:all'),
      accessPolicy.hasPermission(viewer, 'report:export'),
    ]);

    const [departments, groups, projects, overtimeProjects, exportScope] = await Promise.all([
      canDepartmentPermission || canOvertimePermission ? accessPolicy.getVisibleDepartments(viewer) : Promise.resolve([]),
      canGroupPermission || canDepartmentPermission || canOvertimePermission ? accessPolicy.getVisibleGroups(viewer) : Promise.resolve([]),
      canProjectPermission ? accessPolicy.getVisibleReportProjects(viewer) : Promise.resolve([]),
      canOvertimePermission
        ? accessPolicy.getVisibleProjectsForPermissions(viewer, ['report:view:overtime'])
        : Promise.resolve([]),
      canExportPermission
        ? accessPolicy.getPermissionScope(viewer, 'report:export')
        : Promise.resolve({ unrestricted: false, departmentIds: [], groupIds: [], projectIds: [] }),
    ]);

    const canViewDepartment = canDepartmentPermission && departments.length > 0;
    const canViewGroup = canGroupPermission && groups.length > 0;
    const canViewProject = canProjectPermission && projects.length > 0;
    const canViewOvertime = canOvertimePermission
      && (accessPolicy.isAdmin(viewer) || canAllReports
        || departments.length > 0 || groups.length > 0 || overtimeProjects.length > 0);

    res.json({
      code: 0,
      data: {
        canViewPersonal: canPersonal,
        canViewDepartment,
        canViewGroup,
        canViewProject,
        canViewOvertime,
        departments: serializeDepartments(departments),
        groups: serializeGroups(groups),
        projects: serializeProjects(projects),
        overtimeProjects: overtimeProjects.map((project) => ({
          id: project.id,
          name: project.name,
          code: project.code,
          status: project.status,
        })),
        exportScope,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/personal', requirePermission('report:view:self'), async (req: AuthRequest, res, next) => {
  try {
    const { startDate, endDate } = parseReportDateRange(req.query);
    const targetUserId = firstQueryValue(req.query.userId)
      ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId')
      : req.user!.id;

    if (!await accessPolicy.canAccessUserData(req.user!, targetUserId, {
      allPermissions: ['report:view:all'],
      departmentPermissions: ['report:view:department'],
      groupPermissions: ['report:view:group'],
    })) {
      return res.status(403).json({ code: 403, message: '只能查看自己或负责范围内成员的报表' });
    }

    const data = await reportService.getPersonalReport(targetUserId, startDate, endDate);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/group', requirePermission('report:view:group'), async (req: AuthRequest, res, next) => {
  try {
    const groupId = parsePositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (!await accessPolicy.canAccessGroup(req.user!, groupId, { allowDepartmentLeader: false })) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责组别的报表' });
    }

    const groupIds = await accessPolicy.getGroupAndDescendantIds([groupId]);
    const data = await reportService.getGroupReport(groupId, startDate, endDate, groupIds);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/department', requirePermission('report:view:department'), async (req: AuthRequest, res, next) => {
  try {
    const departmentId = parsePositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (!await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责部门的报表' });
    }
    if (groupId && !await accessPolicy.isGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }

    const groupIds = groupId ? await accessPolicy.getGroupAndDescendantIds([groupId]) : undefined;
    const data = await reportService.getDepartmentReport(departmentId, startDate, endDate, { groupId, groupIds });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/project', requirePermission('report:view:project'), async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(firstQueryValue(req.query.projectId), 'projectId');
    const departmentId = parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (!await accessPolicy.canAccessProjectReport(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责项目的报表' });
    }

    const { filters, reportFilters } = await getProjectScopedFilters(projectId, departmentId, groupId);
    const data = await reportService.getProjectReport(projectId, startDate, endDate, reportFilters);
    res.json({ code: 0, data: { ...data, filters } });
  } catch (error) {
    next(error);
  }
});

router.get('/overtime', requirePermission('report:view:overtime'), async (req: AuthRequest, res, next) => {
  try {
    const departmentId = parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const projectId = parseOptionalPositiveInt(firstQueryValue(req.query.projectId), 'projectId');
    const requestedUserId = parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (departmentId && !await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责部门的加班报表' });
    }
    if (groupId && !await accessPolicy.canAccessGroup(req.user!, groupId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责组别的加班报表' });
    }
    if (departmentId && groupId && !await accessPolicy.isGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }
    if (projectId) {
      const projectIds = await accessPolicy.getAccessibleProjectIds(req.user!, ['report:view:overtime']);
      if (projectIds !== null && !projectIds.includes(projectId)) {
        return res.status(403).json({ code: 403, message: '只能查看自己负责项目的加班报表' });
      }
    }
    if (requestedUserId && !await accessPolicy.canAccessUserData(req.user!, requestedUserId, {
      allPermissions: ['report:view:all'],
      departmentPermissions: ['report:view:overtime'],
      groupPermissions: ['report:view:overtime'],
    })) {
      return res.status(403).json({ code: 403, message: '只能查看自己或负责范围内成员的加班报表' });
    }

    let groupIds = groupId ? await accessPolicy.getGroupAndDescendantIds([groupId]) : undefined;
    let departmentIds: number[] | undefined;
    let projectIds: number[] | undefined;
    let matchAnyScope = false;
    let hasAllOvertimeScope = await accessPolicy.hasUnrestrictedPermission(req.user!, 'report:view:all');
    if (!departmentId && !groupId && !projectId && !requestedUserId && !accessPolicy.isAdmin(req.user!)) {
      const [accessibleDepartmentIds, accessibleGroupIds, accessibleProjectIds] = await Promise.all([
        accessPolicy.getAccessibleDepartmentIds(req.user!, ['report:view:overtime']),
        accessPolicy.getAccessibleGroupIds(req.user!, ['report:view:overtime']),
        accessPolicy.getAccessibleProjectIds(req.user!, ['report:view:overtime']),
      ]);
      if (accessibleDepartmentIds === null || accessibleGroupIds === null || accessibleProjectIds === null || hasAllOvertimeScope) {
        hasAllOvertimeScope = true;
        departmentIds = undefined;
        groupIds = undefined;
        projectIds = undefined;
      } else if (accessibleDepartmentIds.length === 0 && accessibleGroupIds.length === 0 && accessibleProjectIds.length === 0) {
        // 有报表码但无任何可见范围（scope 仅 project/self 等），无数据可见，直接返回空
        return res.json({ code: 0, data: { totalDays: 0, byType: {}, byUser: {}, byGroup: {}, records: [] } });
      } else {
        departmentIds = accessibleDepartmentIds.length ? accessibleDepartmentIds : undefined;
        groupIds = accessibleGroupIds.length ? accessibleGroupIds : undefined;
        projectIds = accessibleProjectIds.length ? accessibleProjectIds : undefined;
        matchAnyScope = [departmentIds, groupIds, projectIds].filter((ids) => ids?.length).length > 1;
      }
    }
    const userId = departmentId || groupId || projectId || groupIds?.length || departmentIds?.length || projectIds?.length || hasAllOvertimeScope
      ? requestedUserId
      : (requestedUserId ?? req.user!.id);
    const data = await reportService.getOvertimeReport({
      departmentId,
      departmentIds,
      groupId,
      groupIds,
      projectId,
      projectIds,
      userId,
      startDate,
      endDate,
      matchAnyScope,
      allowAll: hasAllOvertimeScope,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard', async (req: AuthRequest, res, next) => {
  try {
    const [timesheet, overtime, approvals, weeklyReport] = await Promise.all([
      accessPolicy.hasPermission(req.user!, 'timesheet:view:self'),
      accessPolicy.hasPermission(req.user!, 'overtime:view:self'),
      accessPolicy.hasPermission(req.user!, 'approval:view:todo'),
      accessPolicy.hasPermission(req.user!, 'weekly_report:view:self'),
    ]);
    const data = await reportService.getDashboardData(req.user!.id, { timesheet, overtime, approvals, weeklyReport });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/export/personal', requireAllPermissions('report:view:self', 'report:export'), async (req: AuthRequest, res, next) => {
  try {
    const { startDate, endDate } = parseReportDateRange(req.query);
    const userId = firstQueryValue(req.query.userId)
      ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId')
      : req.user!.id;

    if (!await canExportScope(req.user!)) {
      return res.status(403).json({ code: 403, message: '导出权限不包含个人报表范围' });
    }

    if (!await accessPolicy.canAccessUserData(req.user!, userId, {
      allPermissions: ['report:view:all'],
      departmentPermissions: ['report:view:department'],
      groupPermissions: ['report:view:group'],
    })) {
      return res.status(403).json({ code: 403, message: '只能导出自己或负责范围内成员的报表' });
    }

    const data = await reportService.getPersonalReport(userId, startDate, endDate);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('工时报表');
    const statusText: Record<string, string> = { draft: '草稿', submitted: '审批中', approved: '已通过', rejected: '已驳回' };

    sheet.columns = [
      { header: '日期', key: 'date', width: 14 },
      { header: '项目', key: 'project', width: 20 },
      { header: '工时(天)', key: 'days', width: 12 },
      { header: '工作内容', key: 'description', width: 40 },
      { header: '状态', key: 'status', width: 10 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        date: record.date,
        project: record.project?.name || '-',
        days: record.days,
        description: record.description || '',
        status: statusText[record.status] || record.status,
      });
    }

    sheet.addRow([]);
    sheet.addRow({ date: '合计', days: data.totalDays });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=timesheet-report-${startDate}-${endDate}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

router.get('/export/department', requireAllPermissions('report:view:department', 'report:export'), async (req: AuthRequest, res, next) => {
  try {
    const departmentId = parsePositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (!await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责部门的报表' });
    }
    if (groupId && !await accessPolicy.isGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }
    if (!await canExportScope(req.user!, { departmentId, groupId })) {
      return res.status(403).json({ code: 403, message: '导出权限不包含当前部门或组别范围' });
    }

    const groupIds = groupId ? await accessPolicy.getGroupAndDescendantIds([groupId]) : undefined;
    const data = await reportService.getDepartmentReport(departmentId, startDate, endDate, { groupId, groupIds });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('部门工时报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '部门', key: 'department', width: 16 },
      { header: '组别', key: 'group', width: 16 },
      { header: '项目', key: 'project', width: 20 },
      { header: '工时(天)', key: 'days', width: 12 },
      { header: '日期', key: 'date', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        user: record.user?.realName || '-',
        department: record.departmentSnapshotName || '-',
        group: record.groupSnapshotName || '-',
        project: record.project?.name || '-',
        days: record.days,
        date: record.date,
      });
    }

    sheet.addRow([]);
    sheet.addRow({ user: '合计', days: data.totalDays });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=dept-report-${startDate}-${endDate}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

// 导出组别工时报表
router.get('/export/group', requireAllPermissions('report:view:group', 'report:export'), async (req: AuthRequest, res, next) => {
  try {
    const groupId = parsePositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (!await accessPolicy.canAccessGroup(req.user!, groupId, { allowDepartmentLeader: false })) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责组别的报表' });
    }
    if (!await canExportScope(req.user!, { groupId })) {
      return res.status(403).json({ code: 403, message: '导出权限不包含当前组别范围' });
    }

    const groupIds = await accessPolicy.getGroupAndDescendantIds([groupId]);
    const data = await reportService.getGroupReport(groupId, startDate, endDate, groupIds);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('组别工时报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '组别', key: 'group', width: 16 },
      { header: '项目', key: 'project', width: 20 },
      { header: '工时(天)', key: 'days', width: 12 },
      { header: '日期', key: 'date', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        user: record.user?.realName || '-',
        group: record.groupSnapshotName || '-',
        project: record.project?.name || '-',
        days: record.days,
        date: record.date,
      });
    }
    sheet.addRow([]);
    sheet.addRow({ user: '合计', days: data.totalDays });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=group-report-${startDate}-${endDate}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

// 导出项目工时报表
router.get('/export/project', requireAllPermissions('report:view:project', 'report:export'), async (req: AuthRequest, res, next) => {
  try {
    const projectId = parsePositiveInt(firstQueryValue(req.query.projectId), 'projectId');
    const departmentId = parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (!await accessPolicy.canAccessProjectReport(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责项目的报表' });
    }
    if (!await canExportScope(req.user!, { projectId, departmentId, groupId })) {
      return res.status(403).json({ code: 403, message: '导出权限不包含当前项目或筛选范围' });
    }

    const { reportFilters } = await getProjectScopedFilters(projectId, departmentId, groupId);
    const data = await reportService.getProjectReport(projectId, startDate, endDate, reportFilters);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('项目工时报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '部门', key: 'department', width: 16 },
      { header: '组别', key: 'group', width: 16 },
      { header: '工时(天)', key: 'days', width: 12 },
      { header: '日期', key: 'date', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        user: record.user?.realName || '-',
        department: record.departmentSnapshotName || '-',
        group: record.groupSnapshotName || '-',
        days: record.days,
        date: record.date,
      });
    }
    sheet.addRow([]);
    sheet.addRow({ user: '合计', days: data.totalDays });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=project-report-${startDate}-${endDate}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

// 导出加班统计报表
router.get('/export/overtime', requireAllPermissions('report:view:overtime', 'report:export'), async (req: AuthRequest, res, next) => {
  try {
    const departmentId = parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const projectId = parseOptionalPositiveInt(firstQueryValue(req.query.projectId), 'projectId');
    const requestedUserId = parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId');
    const { startDate, endDate } = parseReportDateRange(req.query);

    if (departmentId && !await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责部门的加班报表' });
    }
    if (groupId && !await accessPolicy.canAccessGroup(req.user!, groupId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责组别的加班报表' });
    }
    if (departmentId && groupId && !await accessPolicy.isGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }
    if (projectId) {
      const accessibleProjectIds = await accessPolicy.getAccessibleProjectIds(req.user!, ['report:view:overtime']);
      if (accessibleProjectIds !== null && !accessibleProjectIds.includes(projectId)) {
        return res.status(403).json({ code: 403, message: '只能导出自己负责项目的加班报表' });
      }
    }
    if (requestedUserId && !await accessPolicy.canAccessUserData(req.user!, requestedUserId, {
      allPermissions: ['report:view:all'],
      departmentPermissions: ['report:view:overtime'],
      groupPermissions: ['report:view:overtime'],
    })) {
      return res.status(403).json({ code: 403, message: '只能导出自己或负责范围内成员的加班报表' });
    }
    if (!await canExportScope(req.user!, { departmentId, groupId, projectId })) {
      return res.status(403).json({ code: 403, message: '导出权限不包含当前加班报表范围' });
    }

    let groupIds = groupId ? await accessPolicy.getGroupAndDescendantIds([groupId]) : undefined;
    let departmentIds: number[] | undefined;
    let projectIds: number[] | undefined;
    let hasAllOvertimeScope = await accessPolicy.hasUnrestrictedPermission(req.user!, 'report:view:all');
    let hasNoVisibleScope = false;
    if (!departmentId && !groupId && !projectId && !requestedUserId && !accessPolicy.isAdmin(req.user!)) {
      const [accessibleDepartmentIds, accessibleGroupIds, accessibleProjectIds] = await Promise.all([
        accessPolicy.getAccessibleDepartmentIds(req.user!, ['report:view:overtime']),
        accessPolicy.getAccessibleGroupIds(req.user!, ['report:view:overtime']),
        accessPolicy.getAccessibleProjectIds(req.user!, ['report:view:overtime']),
      ]);
      if (accessibleDepartmentIds === null || accessibleGroupIds === null || accessibleProjectIds === null || hasAllOvertimeScope) {
        hasAllOvertimeScope = true;
      } else if (accessibleDepartmentIds.length === 0 && accessibleGroupIds.length === 0 && accessibleProjectIds.length === 0) {
        hasNoVisibleScope = true;
      } else {
        departmentIds = accessibleDepartmentIds.length ? accessibleDepartmentIds : undefined;
        groupIds = accessibleGroupIds.length ? accessibleGroupIds : undefined;
        projectIds = accessibleProjectIds.length ? accessibleProjectIds : undefined;
      }
    }
    const userId = departmentId || groupId || projectId || groupIds?.length || departmentIds?.length || projectIds?.length || hasAllOvertimeScope
      ? requestedUserId
      : (requestedUserId ?? req.user!.id);
    const data = hasNoVisibleScope
      ? { totalDays: 0, byType: {}, byUser: {}, byGroup: {}, records: [] }
      : await reportService.getOvertimeReport({
        departmentId, departmentIds, groupId, groupIds, projectId, projectIds, userId, startDate, endDate,
        matchAnyScope: [departmentIds, groupIds, projectIds].filter((ids) => ids?.length).length > 1,
        allowAll: hasAllOvertimeScope,
      });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('加班统计报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '日期', key: 'date', width: 14 },
      { header: '加班类型', key: 'type', width: 14 },
      { header: '加班时长(天)', key: 'days', width: 16 },
      { header: '原因', key: 'reason', width: 30 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    const typeText: Record<string, string> = { weekend: '周末加班', holiday: '节假日加班', weekday: '工作日加班' };
    for (const record of data.records as any[]) {
      sheet.addRow({
        user: record.user?.realName || '-',
        date: record.date,
        type: typeText[record.overtimeType] || record.overtimeType,
        days: record.days,
        reason: record.reason || '',
      });
    }
    sheet.addRow([]);
    sheet.addRow({ user: '合计', days: data.totalDays });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=overtime-report-${startDate}-${endDate}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

// ===================== 自定义报表 =====================

function parseReportDefinitionPayload(body: Record<string, unknown>) {
  const name = parseString(body.name, 'name', { required: true, max: 100 })!;
  // config 以 JSON 字符串形式提交：先校验为字符串，再 parse 并走引擎校验确保结构合法
  const configStr = parseString(body.config, 'config', { required: true })!;
  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(configStr);
  } catch {
    throw new BusinessError('config 必须是合法 JSON');
  }
  validateReportQueryConfig(parsedConfig);
  const scope = parseEnum(body.scope ?? 'private', 'scope', REPORT_DEFINITION_SCOPES);
  const scopeGroupId = scope === 'group'
    ? parsePositiveInt(body.scopeGroupId, 'scopeGroupId')
    : parseOptionalPositiveInt(body.scopeGroupId, 'scopeGroupId');
  const scopeDepartmentId = scope === 'department'
    ? parsePositiveInt(body.scopeDepartmentId, 'scopeDepartmentId')
    : parseOptionalPositiveInt(body.scopeDepartmentId, 'scopeDepartmentId');
  return { name, config: configStr, scope, scopeGroupId, scopeDepartmentId };
}

function serializeReportDefinition(def: ReportDefinition) {
  let parsedConfig: unknown = null;
  try {
    parsedConfig = JSON.parse(def.config);
  } catch {
    parsedConfig = null;
  }
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    scopeGroupId: def.scopeGroupId,
    scopeDepartmentId: def.scopeDepartmentId,
    owner: def.owner ? { id: def.owner.id, realName: def.owner.realName } : null,
    ownerId: def.ownerId,
    config: parsedConfig,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

/**
 * 自定义报表定义可见性：
 * - 创建者本人；或
 * - scope=public；或
 * - scope=department 且目标部门为 viewer 所属部门；或
 * - scope=group 且目标组别为 viewer 所属组别。
 */
async function canViewReportDefinition(
  viewer: Viewer,
  def: ReportDefinition,
): Promise<boolean> {
  if (def.ownerId === viewer.id) return true;
  if (def.scope === 'public') return true;
  if (def.scope === 'department' && def.scopeDepartmentId != null) {
    const org = await accessPolicy.getOrgSnapshot(viewer.id);
    return org.departmentSnapshotId === def.scopeDepartmentId;
  }
  if (def.scope === 'group' && def.scopeGroupId != null) {
    const org = await accessPolicy.getOrgSnapshot(viewer.id);
    return org.groupSnapshotId === def.scopeGroupId;
  }
  return false;
}

// 运行自定义报表（body 即引擎 config）
router.post('/custom/run', requirePermission('report:custom:view'), async (req: AuthRequest, res, next) => {
  try {
    const data = await reportEngine.run(req.body, req.user!);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

// 获取自定义报表定义列表（自己的 + 可见共享）
router.get('/custom/definitions', requirePermission('report:custom:view'), async (req: AuthRequest, res, next) => {
  try {
    const viewer = req.user!;
    const org = await accessPolicy.getOrgSnapshot(viewer.id);
    const qb = reportDefinitionRepo().createQueryBuilder('ReportDefinition')
      .leftJoinAndSelect('ReportDefinition.owner', 'owner')
      .where('ReportDefinition.ownerId = :userId', { userId: viewer.id })
      .orWhere('ReportDefinition.scope = :public', { public: 'public' });
    if (org.departmentSnapshotId != null) {
      qb.orWhere(
        '(ReportDefinition.scope = :deptScope AND ReportDefinition.scopeDepartmentId = :deptId)',
        { deptScope: 'department', deptId: org.departmentSnapshotId },
      );
    }
    if (org.groupSnapshotId != null) {
      qb.orWhere(
        '(ReportDefinition.scope = :groupScope AND ReportDefinition.scopeGroupId = :groupId)',
        { groupScope: 'group', groupId: org.groupSnapshotId },
      );
    }
    qb.orderBy('ReportDefinition.createdAt', 'DESC');
    const list = await qb.getMany();
    res.json({ code: 0, data: list.map(serializeReportDefinition) });
  } catch (error) {
    next(error);
  }
});

// 创建自定义报表定义
router.post('/custom/definitions', requirePermission('report:custom:manage'), async (req: AuthRequest, res, next) => {
  try {
    const payload = parseReportDefinitionPayload(req.body as Record<string, unknown>);
    const def = reportDefinitionRepo().create({
      ...payload,
      ownerId: req.user!.id,
    });
    const saved = await reportDefinitionRepo().save(def);
    auditService.log({
      userId: req.user!.id,
      action: 'report_definition.create',
      target: 'report_definition',
      targetId: saved.id,
      detail: JSON.stringify({ name: payload.name, scope: payload.scope }),
      ip: req.ip,
    });
    const reloaded = await reportDefinitionRepo().findOne({
      where: { id: saved.id },
      relations: ['owner'],
    });
    res.json({ code: 0, data: serializeReportDefinition(reloaded!) });
  } catch (error) {
    next(error);
  }
});

// 获取单条自定义报表定义
router.get('/custom/definitions/:id', requirePermission('report:custom:view'), async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const def = await reportDefinitionRepo().findOne({
      where: { id },
      relations: ['owner'],
    });
    if (!def) return res.status(404).json({ code: 404, message: '报表定义不存在' });
    if (!await canViewReportDefinition(req.user!, def)) {
      return res.status(403).json({ code: 403, message: '无权查看该报表定义' });
    }
    res.json({ code: 0, data: serializeReportDefinition(def) });
  } catch (error) {
    next(error);
  }
});

// 更新自定义报表定义（仅 owner）
router.put('/custom/definitions/:id', requirePermission('report:custom:manage'), async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const def = await reportDefinitionRepo().findOne({ where: { id } });
    if (!def) return res.status(404).json({ code: 404, message: '报表定义不存在' });
    if (def.ownerId !== req.user!.id) {
      return res.status(403).json({ code: 403, message: '只能编辑自己创建的报表定义' });
    }
    const payload = parseReportDefinitionPayload(req.body as Record<string, unknown>);
    Object.assign(def, payload);
    const saved = await reportDefinitionRepo().save(def);
    auditService.log({
      userId: req.user!.id,
      action: 'report_definition.update',
      target: 'report_definition',
      targetId: id,
      detail: JSON.stringify({ name: payload.name, scope: payload.scope }),
      ip: req.ip,
    });
    const reloaded = await reportDefinitionRepo().findOne({
      where: { id: saved.id },
      relations: ['owner'],
    });
    res.json({ code: 0, data: serializeReportDefinition(reloaded!) });
  } catch (error) {
    next(error);
  }
});

// 删除自定义报表定义（仅 owner）
router.delete('/custom/definitions/:id', requirePermission('report:custom:manage'), async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const def = await reportDefinitionRepo().findOne({ where: { id } });
    if (!def) return res.status(404).json({ code: 404, message: '报表定义不存在' });
    if (def.ownerId !== req.user!.id) {
      return res.status(403).json({ code: 403, message: '只能删除自己创建的报表定义' });
    }
    await reportDefinitionRepo().delete(id);
    await auditService.log({
      userId: req.user!.id,
      action: 'report_definition.delete',
      target: 'report_definition',
      targetId: id,
      ip: req.ip,
    });
    res.json({ code: 0, message: '删除成功' });
  } catch (error) {
    next(error);
  }
});

export const reportRoutes = router;
