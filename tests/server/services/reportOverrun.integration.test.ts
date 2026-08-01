import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';
import { User } from '@server/entities/User';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { Project } from '@server/entities/Project';
import { ProjectWorkloadAllocation } from '@server/entities/ProjectWorkloadAllocation';
import { Timesheet } from '@server/entities/Timesheet';
import { ReportService } from '@server/services/reportService';

/**
 * 超投统计集成测试：口径与审批配额警告（buildTimesheetQuota）一致。
 * 覆盖：版本去重（v1 approved + v2 submitted 只计 v2）、组族谱覆盖（父组配额含子组成员）、
 * 超投/剩余/超投率计算、权限裁剪。
 */
describe('ReportService 超投统计集成', () => {
  beforeEach(async () => {
    const ds = await setupTestDb();
    const dept = await ds.getRepository(Department).save({ id: 1, name: '研发部', sortOrder: 1 });
    const g1 = await ds.getRepository(Group).save({ id: 1, name: '前端组', departmentId: dept.id, path: '1', sortOrder: 1 });
    const g2 = await ds.getRepository(Group).save({ id: 2, name: 'React小组', departmentId: dept.id, parentId: g1.id, path: '1/2', sortOrder: 1 });
    const g3 = await ds.getRepository(Group).save({ id: 3, name: '后端组', departmentId: dept.id, path: '3', sortOrder: 2 });
    await ds.getRepository(Project).save([
      { id: 1, name: '工时项目', code: 'WTM', status: 'active', managers: [] },
      { id: 2, name: '电商项目', code: 'EC', status: 'active', managers: [] },
    ]);
    await ds.getRepository(User).save([
      { id: 1, username: 'ov-u1', password: 'hash', realName: '甲', status: 1, roles: [], department: dept, group: g1 },
      { id: 2, username: 'ov-u2', password: 'hash', realName: '乙', status: 1, roles: [], department: dept, group: g2 },
      { id: 3, username: 'ov-u3', password: 'hash', realName: '丙', status: 1, roles: [], department: dept, group: g3 },
      { id: 4, username: 'ov-admin', password: 'hash', realName: '管理员', status: 1, roles: [] },
    ]);
    await ds.getRepository(ProjectWorkloadAllocation).save([
      // 项目1：前端组配额 10 天（覆盖组1+组2）；后端组配额 5 天
      { projectId: 1, groupId: 1, groupName: '前端组', allocation: 10 },
      { projectId: 1, groupId: 3, groupName: '后端组', allocation: 5 },
      // 项目2：前端组配额 3 天
      { projectId: 2, groupId: 1, groupName: '前端组', allocation: 3 },
    ]);
  });
  afterEach(teardownTestDb);

  const adminViewer = { id: 4, roles: ['admin'] };

  it('消耗按组族谱统计（父组配额含子组成员），超投/剩余/超投率正确', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    // 前端组(1)成员甲 6 天 + React小组(2)成员乙 6 天 → 前端组配额 10 → 超投 2（12-10）
    await tsRepo.save([
      { userId: 1, projectId: 1, date: '2026-07-01', days: 3, status: 'approved', submissionGroupId: 1, rootGroupId: 1 },
      { userId: 1, projectId: 1, date: '2026-07-02', days: 3, status: 'approved', submissionGroupId: 1, rootGroupId: 1 },
      { userId: 2, projectId: 1, date: '2026-07-03', days: 3, status: 'approved', submissionGroupId: 2, rootGroupId: 2 },
      { userId: 2, projectId: 1, date: '2026-07-04', days: 3, status: 'approved', submissionGroupId: 2, rootGroupId: 2 },
      // 后端组(3)成员丙 4 天 → 配额 5 → 剩余 1
      { userId: 3, projectId: 1, date: '2026-07-05', days: 4, status: 'approved', submissionGroupId: 3, rootGroupId: 3 },
    ]);
    const data = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(data.total).toBe(3);
    const frontend = data.list.find((r: any) => r.projectId === 1 && r.groupId === 1);
    expect(frontend).toMatchObject({ allocation: 10, consumed: 12, remaining: -2, overrun: 2, overrunRate: 20 });
    const backend = data.list.find((r: any) => r.projectId === 1 && r.groupId === 3);
    expect(backend).toMatchObject({ allocation: 5, consumed: 4, remaining: 1, overrun: 0, overrunRate: 0 });
    // 超投排序在前
    expect(data.list[0].projectId).toBe(1);
    expect(data.list[0].groupId).toBe(1);
  });

  it('版本去重：v1 approved 与 v2 submitted 并存时只计最新版本（与审批配额同口径）', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    await tsRepo.save([
      // 用户1 项目1 07-01：v1 approved 3 天（组1）
      { userId: 1, projectId: 1, date: '2026-07-01', days: 3, status: 'approved', submissionGroupId: 10, rootGroupId: 10 },
      // v2 submitted 5 天（同 (user,project,date)，审批窗口期并存）→ 只计 5
      { userId: 1, projectId: 1, date: '2026-07-01', days: 5, status: 'submitted', submissionGroupId: 11, rootGroupId: 10 },
    ]);
    const data = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    const frontend = data.list.find((r: any) => r.projectId === 1 && r.groupId === 1);
    expect(frontend.consumed).toBe(5); // 不是 3+5=8（版本去重）
    expect(frontend.overrun).toBe(0);
  });

  it('时间范围过滤与项目过滤', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    await tsRepo.save([
      { userId: 1, projectId: 1, date: '2026-07-01', days: 5, status: 'approved', submissionGroupId: 1, rootGroupId: 1 },
      { userId: 1, projectId: 1, date: '2026-06-01', days: 5, status: 'approved', submissionGroupId: 2, rootGroupId: 2 }, // 范围外
      { userId: 1, projectId: 2, date: '2026-07-02', days: 2, status: 'approved', submissionGroupId: 3, rootGroupId: 3 },
    ]);
    const data = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31', projectId: 1,
    });
    expect(data.list).toHaveLength(2); // 只有项目1 的两个配额组
    const frontend = data.list.find((r: any) => r.groupId === 1);
    expect(frontend.consumed).toBe(5); // 6 月记录不计入
    // 项目2 的前端组配额：consumed=2（7 月）
    const p2 = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31', projectId: 2,
    });
    expect(p2.list.find((r: any) => r.groupId === 1).consumed).toBe(2);
  });

  it('口径与审批配额同源（sumConsumption 公共函数，v1 保留窗口期不双计）', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    // 同一 (user, project, date) 两个版本：v1 approved 3 天 + v2 submitted 5 天并存
    await tsRepo.save([
      { userId: 1, projectId: 1, date: '2026-07-01', days: 3, status: 'approved', submissionGroupId: 10, rootGroupId: 10 },
      { userId: 1, projectId: 1, date: '2026-07-01', days: 5, status: 'submitted', submissionGroupId: 11, rootGroupId: 10 },
    ]);
    const overrun = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    const frontend = overrun.list.find((r: any) => r.groupId === 1);
    // 与 approvalService.buildTimesheetQuota 共用 utils/timesheetConsumption.sumConsumption：
    // 只计最新版本 5 天，不会把旧 approved 再计一次
    expect(frontend.consumed).toBe(5);
  });

  it('口径切换：consumedScope=approved 时 submitted 工时不消耗配额', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    await tsRepo.save([
      // 甲 3 天已通过 + 乙 4 天审批中（前端组配额 10，覆盖组1+组2）
      { userId: 1, projectId: 1, date: '2026-07-01', days: 3, status: 'approved', submissionGroupId: 1, rootGroupId: 1 },
      { userId: 2, projectId: 1, date: '2026-07-02', days: 4, status: 'submitted', submissionGroupId: 2, rootGroupId: 2 },
    ]);
    // 预警口径（默认）：3 + 4 = 7
    const warn = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    expect(warn.list.find((r: any) => r.groupId === 1).consumed).toBe(7);
    // 结算口径：仅 3
    const settle = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31', consumedScope: 'approved',
    });
    const row = settle.list.find((r: any) => r.groupId === 1);
    expect(row.consumed).toBe(3);
    expect(row.overrun).toBe(0);
  });

  it('consumedByGroup 下钻明细：配额组覆盖范围内逐成员组汇总', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    // 前端组配额 10 覆盖组1+组2：甲(组1) 6 天、乙(组2) 4 天 → 明细两组各自展示
    await tsRepo.save([
      { userId: 1, projectId: 1, date: '2026-07-01', days: 6, status: 'approved', submissionGroupId: 1, rootGroupId: 1 },
      { userId: 2, projectId: 1, date: '2026-07-02', days: 4, status: 'approved', submissionGroupId: 2, rootGroupId: 2 },
    ]);
    const data = await new ReportService(ds.manager).getOverrunStats(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-07-31',
    });
    const frontend = data.list.find((r: any) => r.groupId === 1);
    expect(frontend.consumedByGroup).toHaveLength(2);
    expect(frontend.consumedByGroup).toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: 1, groupName: '前端组', days: 6 }),
      expect.objectContaining({ groupId: 2, groupName: 'React小组', days: 4 }),
    ]));
  });

  it('月度趋势：按 (月, 项目, 配额组) 聚合，支持项目过滤与结算口径', async () => {
    const ds = getTestDataSource();
    const tsRepo = ds.getRepository(Timesheet);
    // 项目1 前端组：7月 6 天 + 8月 5 天（配额 10）；项目2 前端组：7月 2 天（配额 3）
    await tsRepo.save([
      { userId: 1, projectId: 1, date: '2026-07-01', days: 3, status: 'approved', submissionGroupId: 1, rootGroupId: 1 },
      { userId: 2, projectId: 1, date: '2026-07-02', days: 3, status: 'approved', submissionGroupId: 2, rootGroupId: 2 },
      { userId: 1, projectId: 1, date: '2026-08-05', days: 5, status: 'approved', submissionGroupId: 3, rootGroupId: 1 },
      { userId: 1, projectId: 2, date: '2026-07-03', days: 2, status: 'approved', submissionGroupId: 4, rootGroupId: 1 },
      // 乙 8月 4 天审批中 → 预警口径计入、结算口径不计
      { userId: 2, projectId: 1, date: '2026-08-06', days: 4, status: 'submitted', submissionGroupId: 5, rootGroupId: 2 },
    ]);
    const trend = await new ReportService(ds.manager).getOverrunTrend(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-08-31',
    });
    // 项目1 前端组（覆盖组1+组2）：7月消耗 6（无超投）→ 8月 9（超投 0，9<10 无超投）
    const p1f = trend.list.filter((r: any) => r.projectId === 1 && r.groupId === 1);
    expect(p1f).toHaveLength(2);
    expect(p1f.find((r: any) => r.month === '2026-07').consumed).toBe(6);
    expect(p1f.find((r: any) => r.month === '2026-08').consumed).toBe(9); // 5 + 4（含 submitted）
    expect(p1f.find((r: any) => r.month === '2026-08').overrun).toBe(0);
    // 项目2 前端组：7月 2 天（配额 3，无超投）
    const p2f = trend.list.filter((r: any) => r.projectId === 2 && r.groupId === 1);
    expect(p2f).toHaveLength(1);
    expect(p2f[0]).toMatchObject({ month: '2026-07', consumed: 2 });
    // 项目过滤
    const p1Only = await new ReportService(ds.manager).getOverrunTrend(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-08-31', projectId: 1,
    });
    expect(p1Only.list.every((r: any) => r.projectId === 1)).toBe(true);
    // 结算口径：8月 consumed = 5（submitted 4 天不计）
    const settle = await new ReportService(ds.manager).getOverrunTrend(adminViewer, {
      startDate: '2026-07-01', endDate: '2026-08-31', consumedScope: 'approved',
    });
    const p1fSettle = settle.list.filter((r: any) => r.projectId === 1 && r.groupId === 1);
    expect(p1fSettle.find((r: any) => r.month === '2026-08').consumed).toBe(5);
  });
});
