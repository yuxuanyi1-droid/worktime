import { Router } from 'express';
import ExcelJS from 'exceljs';
import { ReportService } from '../services/reportService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { AppDataSource } from '../config/database';
import { Department } from '../entities/Department';
import { Group } from '../entities/Group';
import { Project } from '../entities/Project';
import { canAccessUserData, getGroupAndDescendantIds, getManagedDepartmentIds, getManagedGroupIds } from '../utils/accessControl';
import {
  firstQueryValue,
  parseDateString,
  parseOptionalPositiveInt,
  parsePositiveInt,
} from '../utils/validation';

const router = Router();
const reportService = new ReportService();
const departmentRepo = () => AppDataSource.getRepository(Department);
const groupRepo = () => AppDataSource.getRepository(Group);
const projectRepo = () => AppDataSource.getRepository(Project);

type Viewer = NonNullable<AuthRequest['user']>;

const isAdmin = (viewer: Viewer) => viewer.roles.includes('admin');

async function getVisibleDepartments(viewer: Viewer) {
  if (isAdmin(viewer)) {
    return departmentRepo().find({ relations: ['leader'], order: { sortOrder: 'ASC', createdAt: 'ASC' } });
  }
  const departmentIds = await getManagedDepartmentIds(viewer.id);
  if (!departmentIds.length) return [];
  return departmentRepo().createQueryBuilder('d')
    .leftJoinAndSelect('d.leader', 'leader')
    .where('d.id IN (:...departmentIds)', { departmentIds })
    .orderBy('d.sortOrder', 'ASC')
    .addOrderBy('d.createdAt', 'ASC')
    .getMany();
}

async function getVisibleGroups(viewer: Viewer) {
  if (isAdmin(viewer)) {
    return groupRepo().find({ relations: ['leader', 'parent', 'department'], order: { level: 'ASC', sortOrder: 'ASC' } });
  }

  const managedDepartmentIds = await getManagedDepartmentIds(viewer.id);
  const managedGroupIds = await getManagedGroupIds(viewer.id);
  const qb = groupRepo().createQueryBuilder('g')
    .leftJoinAndSelect('g.leader', 'leader')
    .leftJoinAndSelect('g.parent', 'parent')
    .leftJoinAndSelect('g.department', 'department');

  if (managedDepartmentIds.length && managedGroupIds.length) {
    qb.where('(g.departmentId IN (:...departmentIds) OR g.id IN (:...groupIds))', {
      departmentIds: managedDepartmentIds,
      groupIds: managedGroupIds,
    });
  } else if (managedDepartmentIds.length) {
    qb.where('g.departmentId IN (:...departmentIds)', { departmentIds: managedDepartmentIds });
  } else if (managedGroupIds.length) {
    qb.where('g.id IN (:...groupIds)', { groupIds: managedGroupIds });
  } else {
    return [];
  }

  return qb.orderBy('g.level', 'ASC').addOrderBy('g.sortOrder', 'ASC').getMany();
}

async function getVisibleProjects(viewer: Viewer) {
  const qb = projectRepo().createQueryBuilder('p')
    .leftJoinAndSelect('p.managers', 'manager')
    .leftJoinAndSelect('p.moduleSEs', 'se')
    .leftJoinAndSelect('se.user', 'seUser')
    .leftJoinAndSelect('se.group', 'seGroup')
    .leftJoinAndSelect('seGroup.department', 'seGroupDepartment')
    .orderBy('p.createdAt', 'DESC');

  if (!isAdmin(viewer)) {
    qb.where('manager.id = :userId', { userId: viewer.id });
  }

  return qb.getMany();
}

async function canAccessDepartment(viewer: Viewer, departmentId: number) {
  if (isAdmin(viewer)) return true;
  const department = await departmentRepo().findOne({ where: { id: departmentId } });
  return department?.leaderId === viewer.id;
}

async function canAccessGroup(viewer: Viewer, groupId: number) {
  if (isAdmin(viewer)) return true;
  const group = await groupRepo().findOne({ where: { id: groupId } });
  if (!group) return false;
  if (group.departmentId && await canAccessDepartment(viewer, group.departmentId)) return true;
  const managedGroupIds = await getManagedGroupIds(viewer.id);
  return managedGroupIds.includes(groupId);
}

async function canAccessProject(viewer: Viewer, projectId: number) {
  if (isAdmin(viewer)) return true;
  const project = await projectRepo().findOne({ where: { id: projectId }, relations: ['managers'] });
  return project?.managers?.some((manager) => manager.id === viewer.id) || false;
}

async function assertGroupInDepartment(groupId: number, departmentId: number) {
  const group = await groupRepo().findOne({ where: { id: groupId } });
  return group?.departmentId === departmentId;
}

async function getProjectFilterOptions(projectId: number) {
  const records = await projectRepo().createQueryBuilder('p')
    .leftJoin('p.timesheets', 't')
    .leftJoin('t.user', 'u')
    .leftJoin('u.department', 'd')
    .leftJoin('u.group', 'g')
    .select([
      'd.id AS departmentId',
      'd.name AS departmentName',
      'g.id AS groupId',
      'g.name AS groupName',
      'g.departmentId AS groupDepartmentId',
    ])
    .where('p.id = :projectId', { projectId })
    .andWhere('t.status = :status', { status: 'approved' })
    .groupBy('d.id')
    .addGroupBy('d.name')
    .addGroupBy('g.id')
    .addGroupBy('g.name')
    .addGroupBy('g.departmentId')
    .getRawMany<{
      departmentId: number | null;
      departmentName: string | null;
      groupId: number | null;
      groupName: string | null;
      groupDepartmentId: number | null;
    }>();

  const departments = new Map<number, { id: number; name: string }>();
  const groups = new Map<number, { id: number; name: string; departmentId: number | null }>();

  for (const record of records) {
    if (record.departmentId) departments.set(Number(record.departmentId), { id: Number(record.departmentId), name: record.departmentName || '-' });
    if (record.groupId) {
      groups.set(Number(record.groupId), {
        id: Number(record.groupId),
        name: record.groupName || '-',
        departmentId: record.groupDepartmentId ? Number(record.groupDepartmentId) : null,
      });
    }
  }

  return {
    departments: Array.from(departments.values()),
    groups: Array.from(groups.values()),
  };
}

router.use(authMiddleware);

router.get('/scope', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const viewer = req.user!;
    const [departments, groups, projects, managedGroupIds] = await Promise.all([
      getVisibleDepartments(viewer),
      getVisibleGroups(viewer),
      getVisibleProjects(viewer),
      isAdmin(viewer) ? Promise.resolve([]) : getManagedGroupIds(viewer.id),
    ]);

    res.json({
      code: 0,
      data: {
        canViewDepartment: departments.length > 0,
        canViewGroup: isAdmin(viewer) || managedGroupIds.length > 0,
        canViewProject: projects.length > 0,
        departments: departments.map((department) => ({
          id: department.id,
          name: department.name,
          leaderId: department.leaderId,
          leader: department.leader ? { id: department.leader.id, realName: department.leader.realName } : null,
        })),
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          departmentId: group.departmentId,
          parentId: group.parentId,
          level: group.level,
          leaderId: group.leaderId,
          leader: group.leader ? { id: group.leader.id, realName: group.leader.realName } : null,
          parent: group.parent ? { id: group.parent.id, name: group.parent.name } : null,
          department: group.department ? { id: group.department.id, name: group.department.name } : null,
        })),
        projects: projects.map((project) => ({
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
        })),
      },
    });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/personal', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');
    const targetUserId = firstQueryValue(req.query.userId)
      ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId')
      : req.user!.id;

    if (!await canAccessUserData(req.user!, targetUserId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己或负责范围内成员的报表' });
    }

    const data = await reportService.getPersonalReport(targetUserId, startDate, endDate);
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/group', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const groupId = parsePositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await canAccessGroup(req.user!, groupId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责组别的报表' });
    }

    const groupIds = await getGroupAndDescendantIds([groupId]);
    const data = await reportService.getGroupReport(groupId, startDate, endDate, groupIds);
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/department', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const departmentId = parsePositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责部门的报表' });
    }
    if (groupId && !await assertGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }

    const groupIds = groupId ? await getGroupAndDescendantIds([groupId]) : undefined;
    const data = await reportService.getDepartmentReport(departmentId, startDate, endDate, { groupId, groupIds });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/project', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const projectId = parsePositiveInt(firstQueryValue(req.query.projectId), 'projectId');
    const departmentId = parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await canAccessProject(req.user!, projectId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责项目的报表' });
    }
    if (departmentId && !isAdmin(req.user!)) {
      // 项目负责人可按项目内部门筛选；这里不限制其本部门，只限制必须是项目负责人。
    }
    if (groupId && departmentId && !await assertGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }

    const groupIds = groupId ? await getGroupAndDescendantIds([groupId]) : undefined;
    const data = await reportService.getProjectReport(projectId, startDate, endDate, { departmentId, groupId, groupIds });
    const filters = await getProjectFilterOptions(projectId);
    res.json({ code: 0, data: { ...data, filters } });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/overtime', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const departmentId = parseOptionalPositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const requestedUserId = parseOptionalPositiveInt(firstQueryValue(req.query.userId), 'userId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (departmentId && !await canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责部门的加班报表' });
    }
    if (groupId && !await canAccessGroup(req.user!, groupId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己负责组别的加班报表' });
    }
    if (departmentId && groupId && !await assertGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }
    if (requestedUserId && !await canAccessUserData(req.user!, requestedUserId)) {
      return res.status(403).json({ code: 403, message: '只能查看自己或负责范围内成员的加班报表' });
    }

    const userId = departmentId || groupId ? undefined : (requestedUserId ?? req.user!.id);
    const groupIds = groupId ? await getGroupAndDescendantIds([groupId]) : undefined;
    const data = await reportService.getOvertimeReport({
      departmentId,
      groupId,
      groupIds,
      userId,
      startDate,
      endDate,
    });
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/dashboard', async (req: AuthRequest, res) => {
  try {
    const data = await reportService.getDashboardData(req.user!.id);
    res.json({ code: 0, data });
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/export/personal', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');
    const userId = firstQueryValue(req.query.userId)
      ? parsePositiveInt(firstQueryValue(req.query.userId), 'userId')
      : req.user!.id;

    if (!await canAccessUserData(req.user!, userId)) {
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
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

router.get('/export/department', requirePermission('report:read'), async (req: AuthRequest, res) => {
  try {
    const departmentId = parsePositiveInt(firstQueryValue(req.query.departmentId), 'departmentId');
    const groupId = parseOptionalPositiveInt(firstQueryValue(req.query.groupId), 'groupId');
    const startDate = parseDateString(firstQueryValue(req.query.startDate), 'startDate');
    const endDate = parseDateString(firstQueryValue(req.query.endDate), 'endDate');

    if (!await canAccessDepartment(req.user!, departmentId)) {
      return res.status(403).json({ code: 403, message: '只能导出自己负责部门的报表' });
    }
    if (groupId && !await assertGroupInDepartment(groupId, departmentId)) {
      return res.status(400).json({ code: 400, message: '组别不属于当前部门' });
    }

    const groupIds = groupId ? await getGroupAndDescendantIds([groupId]) : undefined;
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
        department: record.user?.department?.name || '-',
        group: record.user?.group?.name || '-',
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
  } catch (error: any) {
    res.status(400).json({ code: 400, message: error.message });
  }
});

export const reportRoutes = router;
