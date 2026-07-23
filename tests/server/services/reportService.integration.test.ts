import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { OvertimeApplication } from '@server/entities/OvertimeApplication';
import { WeeklyReport } from '@server/entities/WeeklyReport';
import { Project } from '@server/entities/Project';
import { Timesheet } from '@server/entities/Timesheet';
import { User } from '@server/entities/User';
import { ApprovalService } from '@server/services/approvalService';
import { ReportService } from '@server/services/reportService';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('ReportService 报表统计集成', () => {
  beforeEach(setupTestDb);
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownTestDb();
  });

  async function seedBase() {
    const db = getTestDataSource();
    const department = await db.getRepository(Department).save({ name: '研发部', sortOrder: 1 });
    const otherDepartment = await db.getRepository(Department).save({ name: '交付部', sortOrder: 2 });
    const group = await db.getRepository(Group).save({
      name: '平台组', departmentId: department.id, department, level: 0, sortOrder: 1,
    });
    const otherGroup = await db.getRepository(Group).save({
      name: '实施组', departmentId: otherDepartment.id, department: otherDepartment, level: 0, sortOrder: 1,
    });
    const user = await db.getRepository(User).save({
      username: 'report-user', password: 'hash', realName: '张三', status: 1,
      department, group, roles: [],
    });
    const otherUser = await db.getRepository(User).save({
      username: 'other-user', password: 'hash', realName: '李四', status: 1,
      department: otherDepartment, group: otherGroup, roles: [],
    });
    const project = await db.getRepository(Project).save({
      name: '工时系统', code: 'REPORT-P1', status: 'active', managers: [],
    });
    const otherProject = await db.getRepository(Project).save({
      name: '其他项目', code: 'REPORT-P2', status: 'active', managers: [],
    });
    return { db, department, otherDepartment, group, otherGroup, user, otherUser, project, otherProject };
  }

  it('个人报表仅统计日期范围内已通过的最新版本，并按各维度汇总', async () => {
    const { db, department, group, user, project, otherProject } = await seedBase();
    await db.getRepository(Timesheet).save([
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-01', days: 0.3,
        status: 'approved', submissionGroupId: 1, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-01', days: 0.4,
        status: 'approved', submissionGroupId: 2, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project: otherProject, projectId: otherProject.id, date: '2026-07-02', days: 0.6,
        status: 'approved', submissionGroupId: 3, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-03', days: 1,
        status: 'submitted', submissionGroupId: 4, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-08-01', days: 1,
        status: 'approved', submissionGroupId: 5, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);

    const result = await new ReportService(db.manager).getPersonalReport(user.id, '2026-07-01', '2026-07-31');

    expect(result.totalDays).toBe(1);
    expect(result.byDate).toEqual({ '2026-07-01': 0.4, '2026-07-02': 0.6 });
    expect(result.byUser['张三']).toEqual({ days: 1, count: 2 });
    expect(result.byProject['工时系统']).toEqual({ days: 0.4, count: 1 });
    expect(result.byProject['其他项目']).toEqual({ days: 0.6, count: 1 });
    expect(result.byDepartment['研发部']).toEqual({ days: 1, count: 2 });
    expect(result.byGroup['平台组']).toEqual({ days: 1, count: 2 });
    expect(result.records).toHaveLength(2);
  });

  it('部门、组别与项目报表严格应用快照范围及状态过滤', async () => {
    const { db, department, otherDepartment, group, otherGroup, user, otherUser, project } = await seedBase();
    await db.getRepository(Timesheet).save([
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-10', days: 1,
        status: 'approved', submissionGroupId: 10, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user: otherUser, userId: otherUser.id, project, projectId: project.id, date: '2026-07-10', days: 0.5,
        status: 'approved', submissionGroupId: 11, departmentSnapshotId: otherDepartment.id,
        departmentSnapshotName: otherDepartment.name, groupSnapshotId: otherGroup.id, groupSnapshotName: otherGroup.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-11', days: 0.8,
        status: 'submitted', submissionGroupId: 12, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);
    const service = new ReportService(db.manager);

    expect((await service.getDepartmentReport(department.id, '2026-07-01', '2026-07-31')).totalDays).toBe(1);
    expect((await service.getGroupReport(group.id, '2026-07-01', '2026-07-31', [group.id])).totalDays).toBe(1);
    expect((await service.getProjectReport(project.id, '2026-07-01', '2026-07-31', {
      departmentId: department.id,
    })).totalDays).toBe(1);
  });

  it('加班报表默认取范围交集，matchAnyScope 时取部门与组别范围并集', async () => {
    const { db, department, otherDepartment, group, otherGroup, user, otherUser, project, otherProject } = await seedBase();
    await db.getRepository(OvertimeApplication).save([
      {
        user, userId: user.id, date: '2026-07-05', overtimeType: 'weekend', days: 0.5,
        project, projectId: project.id,
        status: 'approved', departmentSnapshotId: department.id, departmentSnapshotName: department.name,
        groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user: otherUser, userId: otherUser.id, date: '2026-07-06', overtimeType: 'holiday', days: 1,
        project: otherProject, projectId: otherProject.id,
        status: 'approved', departmentSnapshotId: otherDepartment.id, departmentSnapshotName: otherDepartment.name,
        groupSnapshotId: otherGroup.id, groupSnapshotName: otherGroup.name,
      },
      {
        user, userId: user.id, date: '2026-07-07', overtimeType: 'weekday', days: 0.25,
        project, projectId: project.id,
        status: 'submitted', departmentSnapshotId: department.id, departmentSnapshotName: department.name,
        groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);
    const service = new ReportService(db.manager);

    const intersection = await service.getOvertimeReport({
      departmentIds: [department.id], groupIds: [otherGroup.id],
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(intersection.totalDays).toBe(0);

    const union = await service.getOvertimeReport({
      departmentIds: [department.id], groupIds: [otherGroup.id], matchAnyScope: true,
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(union.totalDays).toBe(1.5);
    expect(union.byType).toEqual({ weekend: 0.5, holiday: 1 });
    expect(union.byUser).toEqual({ '张三': 0.5, '李四': 1 });

    const projectOnly = await service.getOvertimeReport({
      projectId: project.id,
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(projectOnly.totalDays).toBe(0.5);

    const crossDimensionUnion = await service.getOvertimeReport({
      departmentIds: [department.id], projectIds: [otherProject.id], matchAnyScope: true,
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(crossDimensionUnion.totalDays).toBe(1.5);
  });

  it('只有显式 allowAll 才允许无范围查询加班数据', async () => {
    const { db, department, group, user } = await seedBase();
    await db.getRepository(OvertimeApplication).save({
      user, userId: user.id, date: '2026-07-05', overtimeType: 'weekend', days: 0.5,
      status: 'approved', departmentSnapshotId: department.id, departmentSnapshotName: department.name,
      groupSnapshotId: group.id, groupSnapshotName: group.name,
    });
    const service = new ReportService(db.manager);
    await expect(service.getOvertimeReport({
      startDate: '2026-07-01', endDate: '2026-07-31',
    })).rejects.toThrow('加班报表缺少数据范围约束');

    await expect(service.getOvertimeReport({
      startDate: '2026-07-01', endDate: '2026-07-31', allowAll: true,
    })).resolves.toMatchObject({ totalDays: 0.5 });
  });

  it('工作台按可见性跳过无权限查询并汇总当月数据', async () => {
    const { db, department, group, user, project } = await seedBase();
    const now = new Date();
    const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-02`;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const isoWeekday = now.getDay() || 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - isoWeekday + 1);
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - isoWeekday + 7);
    const localDate = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    await db.getRepository(Timesheet).save([
      {
        user, userId: user.id, project, projectId: project.id, date: currentDate, days: 0.75,
        status: 'approved', submissionGroupId: 20, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: today, days: 0.25,
        status: 'draft', submissionGroupId: null, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);
    await db.getRepository(WeeklyReport).save({
      user, userId: user.id, weekStart: localDate(monday), weekEnd: localDate(sunday),
      content: '本周工作', summary: '', totalDays: 1, status: 'submitted',
    });
    vi.spyOn(ApprovalService.prototype, 'getPendingList').mockResolvedValue({ total: 3 } as any);

    const visible = await new ReportService(db.manager).getDashboardData(user.id, {
      timesheet: true, overtime: false, approvals: true, weeklyReport: true,
    });
    expect(visible).toEqual({
      monthDays: 1,
      overtimeDays: 0,
      pendingCount: 3,
      trend: currentDate === today
        ? [{ date: currentDate, days: 1 }]
        : [{ date: currentDate, days: 0.75 }, { date: today, days: 0.25 }],
      hasTimesheetDrafts: true,
      weeklyReportStatus: 'submitted',
    });

    const hidden = await new ReportService(db.manager).getDashboardData(user.id, {
      timesheet: false, overtime: false, approvals: false, weeklyReport: false,
    });
    expect(hidden).toEqual({
      monthDays: 0, overtimeDays: 0, pendingCount: 0, trend: [],
      hasTimesheetDrafts: false, weeklyReportStatus: null,
    });
  });
});
