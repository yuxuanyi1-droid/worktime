import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { OvertimeApplication } from '@server/entities/OvertimeApplication';
import { WeeklyReport } from '@server/entities/WeeklyReport';
import { Project } from '@server/entities/Project';
import { Timesheet } from '@server/entities/Timesheet';
import { User } from '@server/entities/User';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
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
    // P3 统一：加班 byUser 与普通报表同构为 { days, count }
    expect(union.byUser).toEqual({ '张三': { days: 0.5, count: 1 }, '李四': { days: 1, count: 1 } });

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
    // P1 口径：本月工时仅统计 approved（与报表一致），草稿不并入 monthDays
    expect(visible).toEqual({
      monthDays: 0.75,
      overtimeDays: 0,
      pendingCount: 3,
      trend: [{ date: currentDate, days: 0.75 }],
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

  it('P1：工作台月工时在审批窗口期不双计（v1 approved + v2 submitted 并存只计已通过版本）', async () => {
    const { db, department, group, user, project } = await seedBase();
    const now = new Date();
    const day1 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-02`;
    await db.getRepository(Timesheet).save([
      {
        user, userId: user.id, project, projectId: project.id, date: day1, days: 3,
        status: 'approved', submissionGroupId: 30, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: day1, days: 5,
        status: 'submitted', submissionGroupId: 31, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);
    const data = await new ReportService(db.manager).getDashboardData(user.id, {
      timesheet: true, overtime: false, approvals: false, weeklyReport: false,
    });
    // 修复前为 3 + 5 = 8（双计）；修复后与报表口径一致：approved 版本去重 = 3
    expect(data.monthDays).toBe(3);
    expect(data.trend).toEqual([{ date: day1, days: 3 }]);
    expect(data.hasTimesheetDrafts).toBe(false);
  });

  it('工时状态分布：各状态独立版本去重，approved 档与报表主统计一致', async () => {
    const { db, department, group, user, project } = await seedBase();
    await db.getRepository(Timesheet).save([
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-01', days: 3,
        status: 'approved', submissionGroupId: 40, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-01', days: 5,
        status: 'submitted', submissionGroupId: 41, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user, userId: user.id, project, projectId: project.id, date: '2026-07-02', days: 2,
        status: 'draft', submissionGroupId: null, departmentSnapshotId: department.id,
        departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);
    const service = new ReportService(db.manager);
    const breakdown = await service.getStatusBreakdown('2026-07-01', '2026-07-31', { userId: user.id });
    expect(breakdown).toEqual({ approved: 3, submitted: 5, draft: 2 });
    // approved 档与报表主统计同口径（dedupReportTimesheets）
    const report = await service.getPersonalReport(user.id, '2026-07-01', '2026-07-31');
    expect(report.totalDays).toBe(3);
    expect(breakdown.approved).toBe(report.totalDays);
    // 部门范围过滤
    const deptBreakdown = await service.getStatusBreakdown('2026-07-01', '2026-07-31', { departmentId: department.id });
    expect(deptBreakdown).toEqual({ approved: 3, submitted: 5, draft: 2 });
  });

  it('提交覆盖度：分子分母同按当前组织归属，未提交成员拉低覆盖率', async () => {
    const { db, department, group, user, project } = await seedBase();
    // 研发部在职 2 人：张三有提交、李四无提交（李四在交付部，不属于研发部——换一个研发部成员）
    const lazyUser = await db.getRepository(User).save({
      username: 'lazy-user', password: 'hash', realName: '王五', status: 1,
      department, group, roles: [],
    });
    await db.getRepository(Timesheet).save({
      user, userId: user.id, project, projectId: project.id, date: '2026-07-01', days: 1,
      status: 'approved', submissionGroupId: 50, departmentSnapshotId: department.id,
      departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
    });
    const service = new ReportService(db.manager);
    const coverage = await service.getCoverage({
      departmentId: department.id, startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(coverage).toEqual({ memberCount: 2, submittedUserCount: 1, coverageRate: 50 });
    // 离职成员不计入分母
    await db.getRepository(User).update(lazyUser.id, { status: 0 });
    const afterLeave = await service.getCoverage({
      departmentId: department.id, startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(afterLeave.memberCount).toBe(1);
    expect(afterLeave.coverageRate).toBe(100);
  });

  it('审批效率：平均审批时长与驳回率按已闭合实例统计，范围按工时快照过滤', async () => {
    const { db, department, group, user, project } = await seedBase();
    const ts1 = await db.getRepository(Timesheet).save({
      user, userId: user.id, project, projectId: project.id, date: '2026-07-01', days: 1,
      status: 'approved', submissionGroupId: 60, departmentSnapshotId: department.id,
      departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
    });
    const ts2 = await db.getRepository(Timesheet).save({
      user, userId: user.id, project, projectId: project.id, date: '2026-07-02', days: 1,
      status: 'submitted', submissionGroupId: 61, departmentSnapshotId: department.id,
      departmentSnapshotName: department.name, groupSnapshotId: group.id, groupSnapshotName: group.name,
    });
    const base = new Date('2026-07-01T09:00:00+08:00');
    const instanceRepo = db.getRepository(ApprovalInstance);
    await instanceRepo.save([
      {
        targetType: 'timesheet', targetId: ts1.id, applicantId: user.id, applicant: user,
        status: 'approved', totalSteps: 1, currentStepOrder: 1, stepsSnapshot: [],
        submittedAt: base, finishedAt: new Date(base.getTime() + 2 * 3_600_000),
      },
      {
        targetType: 'timesheet', targetId: ts2.id, applicantId: user.id, applicant: user,
        status: 'rejected', totalSteps: 1, currentStepOrder: 1, stepsSnapshot: [],
        submittedAt: base, finishedAt: new Date(base.getTime() + 10 * 3_600_000),
      },
      {
        targetType: 'timesheet', targetId: ts2.id, applicantId: user.id, applicant: user,
        status: 'pending', totalSteps: 1, currentStepOrder: 1, stepsSnapshot: [],
        submittedAt: base, finishedAt: null,
      },
    ]);
    const service = new ReportService(db.manager);
    const efficiency = await service.getApprovalEfficiency({
      departmentId: department.id, startDate: '2026-07-01', endDate: '2026-07-31',
    });
    // 2 个已闭合（1 approved 2 小时 + 1 rejected 10 小时）→ 平均 6 小时；驳回率 50%
    expect(efficiency).toEqual({
      avgDurationHours: 6, closedCount: 2, rejectedCount: 1, rejectRate: 50,
    });
    // 项目范围过滤同样生效；无闭合实例 → 0
    const none = await service.getApprovalEfficiency({
      departmentId: department.id, startDate: '2026-08-01', endDate: '2026-08-31',
    });
    expect(none).toEqual({ avgDurationHours: 0, closedCount: 0, rejectedCount: 0, rejectRate: 0 });
  });
});
