import { Router } from 'express';
import ExcelJS from 'exceljs';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireAllPermissions, requirePermission } from '../middleware/permission';
import { AccessPolicyService } from '../services/accessPolicyService';
import { ReportService } from '../services/reportService';
import { BusinessError } from '../utils/errors';
import {
  firstQueryValue,
  parseDateString,
  parseOptionalPositiveInt,
  parsePositiveInt,
} from '../utils/validation';

const router = Router();
const reportService = new ReportService();
const accessPolicy = new AccessPolicyService();
const timesheetRepo = () => AppDataSource.getRepository(Timesheet);

type Viewer = NonNullable<AuthRequest['user']>;

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
    ] = await Promise.all([
      accessPolicy.hasPermission(viewer, 'report:view:self'),
      accessPolicy.hasPermission(viewer, 'report:view:group'),
      accessPolicy.hasPermission(viewer, 'report:view:department'),
      accessPolicy.hasPermission(viewer, 'report:view:project'),
      accessPolicy.hasPermission(viewer, 'report:view:overtime'),
    ]);

    const [departments, groups, projects] = await Promise.all([
      canDepartmentPermission || canOvertimePermission ? accessPolicy.getVisibleDepartments(viewer) : Promise.resolve([]),
      canGroupPermission || canDepartmentPermission || canOvertimePermission ? accessPolicy.getVisibleGroups(viewer) : Promise.resolve([]),
      canProjectPermission ? accessPolicy.getVisibleReportProjects(viewer) : Promise.resolve([]),
    ]);

    const canViewDepartment = canDepartmentPermission && departments.length > 0;
    const canViewGroup = canGroupPermission && groups.length > 0;
    const canViewProject = canProjectPermission && projects.length > 0;
    const canViewOvertime = canOvertimePermission
      && (departments.length > 0 || groups.length > 0);

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
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/personal', requirePermission('report:view:self'), async (req: AuthRequest, res, next) => {
  try {
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');
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
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

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
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

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
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

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
    const requestedUserId = parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (departmentId && !await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责部门的加班报表' });
    }
    if (groupId && !await accessPolicy.canAccessGroup(req.user!, groupId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责组别的加班报表' });
    }
    if (departmentId && groupId && !await accessPolicy.isGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
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
    let matchAnyScope = false;
    let hasAllOvertimeScope = accessPolicy.isAdmin(req.user!) || await accessPolicy.hasPermission(req.user!, 'report:view:all');
    if (!departmentId && !groupId && !requestedUserId && !accessPolicy.isAdmin(req.user!)) {
      const [accessibleDepartmentIds, accessibleGroupIds] = await Promise.all([
        accessPolicy.getAccessibleDepartmentIds(req.user!, ['report:view:overtime']),
        accessPolicy.getAccessibleGroupIds(req.user!, ['report:view:overtime']),
      ]);
      if (accessibleDepartmentIds === null || accessibleGroupIds === null || hasAllOvertimeScope) {
        hasAllOvertimeScope = true;
        departmentIds = undefined;
        groupIds = undefined;
      } else {
        departmentIds = accessibleDepartmentIds.length ? accessibleDepartmentIds : undefined;
        groupIds = accessibleGroupIds.length ? accessibleGroupIds : undefined;
        matchAnyScope = !!departmentIds?.length && !!groupIds?.length;
      }
    }
    const userId = departmentId || groupId || groupIds?.length || departmentIds?.length || hasAllOvertimeScope
      ? requestedUserId
      : (requestedUserId ?? req.user!.id);
    const data = await reportService.getOvertimeReport({
      departmentId,
      departmentIds,
      groupId,
      groupIds,
      userId,
      startDate,
      endDate,
      matchAnyScope,
    });
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard', async (req: AuthRequest, res, next) => {
  try {
    const data = await reportService.getDashboardData(req.user!.id);
    res.json({ code: 0, data });
  } catch (error) {
    next(error);
  }
});

router.get('/export/personal', requireAllPermissions('report:view:self', 'report:export'), async (req: AuthRequest, res, next) => {
  try {
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');
    const userId = firstQueryValue(req.query.userId)
      ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId')
      : req.user!.id;

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
      { header: '工时(天)', key: 'hours', width: 12 },
      { header: '工作内容', key: 'description', width: 40 },
      { header: '状态', key: 'status', width: 10 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        date: record.date,
        project: record.project?.name || '-',
        hours: record.hours,
        description: record.description || '',
        status: statusText[record.status] || record.status,
      });
    }

    sheet.addRow([]);
    sheet.addRow({ date: '合计', hours: data.totalHours });

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
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责部门的报表' });
    }
    if (groupId && !await accessPolicy.isGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
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
      { header: '工时(天)', key: 'hours', width: 12 },
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
        hours: record.hours,
        date: record.date,
      });
    }

    sheet.addRow([]);
    sheet.addRow({ user: '合计', hours: data.totalHours });

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
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await accessPolicy.canAccessGroup(req.user!, groupId, { allowDepartmentLeader: false })) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责组别的报表' });
    }

    const groupIds = await accessPolicy.getGroupAndDescendantIds([groupId]);
    const data = await reportService.getGroupReport(groupId, startDate, endDate, groupIds);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('组别工时报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '组别', key: 'group', width: 16 },
      { header: '项目', key: 'project', width: 20 },
      { header: '工时(天)', key: 'hours', width: 12 },
      { header: '日期', key: 'date', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        user: record.user?.realName || '-',
        group: record.groupSnapshotName || '-',
        project: record.project?.name || '-',
        hours: record.hours,
        date: record.date,
      });
    }
    sheet.addRow([]);
    sheet.addRow({ user: '合计', hours: data.totalHours });

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
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await accessPolicy.canAccessProjectReport(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责项目的报表' });
    }

    const { reportFilters } = await getProjectScopedFilters(projectId, departmentId, groupId);
    const data = await reportService.getProjectReport(projectId, startDate, endDate, reportFilters);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('项目工时报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '部门', key: 'department', width: 16 },
      { header: '组别', key: 'group', width: 16 },
      { header: '工时(天)', key: 'hours', width: 12 },
      { header: '日期', key: 'date', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E0FF' } };

    for (const record of data.records as any[]) {
      sheet.addRow({
        user: record.user?.realName || '-',
        department: record.departmentSnapshotName || '-',
        group: record.groupSnapshotName || '-',
        hours: record.hours,
        date: record.date,
      });
    }
    sheet.addRow([]);
    sheet.addRow({ user: '合计', hours: data.totalHours });

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
    const requestedUserId = parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (departmentId && !await accessPolicy.canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责部门的加班报表' });
    }
    if (groupId && !await accessPolicy.canAccessGroup(req.user!, groupId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责组别的加班报表' });
    }

    let groupIds = groupId ? await accessPolicy.getGroupAndDescendantIds([groupId]) : undefined;
    let departmentIds: number[] | undefined;
    const hasAllOvertimeScope = accessPolicy.isAdmin(req.user!) || await accessPolicy.hasPermission(req.user!, 'report:view:all');
    if (!departmentId && !groupId && !requestedUserId && !accessPolicy.isAdmin(req.user!)) {
      const [accessibleDepartmentIds, accessibleGroupIds] = await Promise.all([
        accessPolicy.getAccessibleDepartmentIds(req.user!, ['report:view:overtime']),
        accessPolicy.getAccessibleGroupIds(req.user!, ['report:view:overtime']),
      ]);
      departmentIds = accessibleDepartmentIds?.length ? accessibleDepartmentIds : undefined;
      groupIds = accessibleGroupIds?.length ? accessibleGroupIds : (groupIds ?? undefined);
    }
    const userId = departmentId || groupId || groupIds?.length || departmentIds?.length || hasAllOvertimeScope
      ? requestedUserId
      : (requestedUserId ?? req.user!.id);
    const data = await reportService.getOvertimeReport({
      departmentId, departmentIds, groupId, groupIds, userId, startDate, endDate,
      matchAnyScope: !!departmentIds?.length && !!groupIds?.length,
    });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('加班统计报表');

    sheet.columns = [
      { header: '人员', key: 'user', width: 14 },
      { header: '日期', key: 'date', width: 14 },
      { header: '加班类型', key: 'type', width: 14 },
      { header: '加班时长(小时)', key: 'hours', width: 16 },
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
        hours: record.hours,
        reason: record.reason || '',
      });
    }
    sheet.addRow([]);
    sheet.addRow({ user: '合计', hours: data.totalHours });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=overtime-report-${startDate}-${endDate}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

export const reportRoutes = router;
