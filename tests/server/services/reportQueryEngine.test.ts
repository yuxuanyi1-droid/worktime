import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { OvertimeApplication } from '@server/entities/OvertimeApplication';
import { Permission } from '@server/entities/Permission';
import { Project } from '@server/entities/Project';
import { Role } from '@server/entities/Role';
import { Timesheet } from '@server/entities/Timesheet';
import { User } from '@server/entities/User';
import { ReportQueryEngine, validateReportQueryConfig } from '@server/services/reportQueryEngine';
import { BusinessError } from '@server/utils/errors';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

/**
 * ReportQueryEngine 单元/集成测试。
 *
 * 重点验证：
 *  1. 维度聚合（行维度 / 透视）；
 *  2. 默认 status=approved（submitted 不计入）；
 *  3. distinctUsers totals 不可加 → 独立查询；
 *  4. 可见范围裁剪：仅有 report:custom:view → 仅本人；
 *  5. 越权 filter 求交裁剪（请求不可见部门 → 空结果）。
 */
describe('ReportQueryEngine', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  async function makeUser(realName: string, permCodes: string[], department?: Department, group?: Group) {
    const db = getTestDataSource();
    // Permission.code 有唯一约束：多次创建用户时按 code 复用已存在的权限行
    const permissions = [];
    for (const code of permCodes) {
      let perm = await db.getRepository(Permission).findOne({ where: { code } });
      if (!perm) {
        perm = await db.getRepository(Permission).save({
          code,
          name: code,
          module: 'report',
          action: code,
          grantable: false,
          scopeTypes: null,
        });
      }
      permissions.push(perm);
    }
    const role = await db.getRepository(Role).save({
      name: `role_${realName}_${Math.random().toString(36).slice(2, 6)}`,
      label: realName,
      permissions,
    });
    return db.getRepository(User).save({
      username: `u_${realName}_${Math.random().toString(36).slice(2, 6)}`,
      password: 'hash',
      realName,
      status: 1,
      department,
      group,
      roles: [role],
    });
  }

  function tsRow(
    user: User, project: Project, dept: Department, group: Group,
    date: string, days: number, status: Timesheet['status'] = 'approved',
  ) {
    return {
      user, userId: user.id, project, projectId: project.id, date, days, status,
      departmentSnapshotId: dept.id, departmentSnapshotName: dept.name,
      groupSnapshotId: group.id, groupSnapshotName: group.name,
    };
  }

  async function seedBase() {
    const db = getTestDataSource();
    const dept = await db.getRepository(Department).save({ name: '研发部', sortOrder: 1 });
    const otherDept = await db.getRepository(Department).save({ name: '交付部', sortOrder: 2 });
    const group = await db.getRepository(Group).save({
      name: '平台组', departmentId: dept.id, department: dept, level: 0, sortOrder: 1,
    });
    const project = await db.getRepository(Project).save({
      name: '工时系统', code: 'P1', status: 'active', managers: [],
    });

    // 管理员（admin 角色绕过权限校验，可看全量）
    const adminUser = await db.getRepository(User).save({
      username: 'admin', password: 'h', realName: '管理员', status: 1,
      department: dept, group, roles: [],
    });

    // 仅有 report:custom:view → 仅本人
    const selfUser = await makeUser('张三', ['report:custom:view'], dept, group);
    // 拥有 report:view:department（设为研发部负责人 → 可见研发部）
    const deptViewer = await makeUser('李四', ['report:custom:view', 'report:view:department'], dept, group);
    dept.leaderId = deptViewer.id;
    await db.getRepository(Department).save(dept);

    // 另一部门用户
    const otherGroup = await db.getRepository(Group).save({
      name: '交付组', departmentId: otherDept.id, department: otherDept, level: 0, sortOrder: 1,
    });
    const otherUser = await makeUser('王五', ['report:custom:view'], otherDept, otherGroup);

    return { db, dept, otherDept, group, otherGroup, project, adminUser, selfUser, deptViewer, otherUser };
  }

  it('validateReportQueryConfig 拒绝非法枚举与缺字段', () => {
    expect(() => validateReportQueryConfig({ source: 'unknown', startDate: '2026-07-01', endDate: '2026-07-02', rowDimension: 'user', measures: ['sumDays'] })).toThrow(BusinessError);
    expect(() => validateReportQueryConfig({ source: 'timesheet', startDate: 'bad', endDate: '2026-07-02', rowDimension: 'user', measures: ['sumDays'] })).toThrow(BusinessError);
    expect(() => validateReportQueryConfig({ source: 'timesheet', startDate: '2026-07-05', endDate: '2026-07-01', rowDimension: 'user', measures: ['sumDays'] })).toThrow(BusinessError);
    expect(() => validateReportQueryConfig({ source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-02', rowDimension: 'user', measures: [] })).toThrow(BusinessError);
    // overtimeType 维度对 timesheet 源非法
    expect(() => validateReportQueryConfig({ source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-02', rowDimension: 'overtimeType', measures: ['sumDays'] })).toThrow(BusinessError);
    // 默认 statuses = approved
    expect(validateReportQueryConfig({ source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-02', rowDimension: 'user', measures: ['sumDays'] }).filters?.statuses).toEqual(['approved']);
  });

  it('维度聚合：按用户行维度汇总 sumDays 与 count，默认仅统计 approved', async () => {
    const { db, dept, group, project, adminUser, selfUser, otherUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(selfUser, project, dept, group, '2026-07-02', 0.3),
      tsRow(otherUser, project, dept, group, '2026-07-01', 0.8),
      tsRow(selfUser, project, dept, group, '2026-07-03', 0.2, 'submitted'),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays', 'count'],
    }, { id: adminUser.id, roles: ['admin'] });

    // submitted 不计入（默认 statuses=['approved']）
    expect(result.grandTotal.sumDays).toBe(1.6);
    expect(result.grandTotal.count).toBe(3);
    const labels = result.rowKeys.map((r) => r.label).sort();
    expect(labels).toEqual(['张三', '王五']);
    const selfKey = result.rowKeys.find((r) => r.label === '张三')!.key;
    expect(result.rowTotals[selfKey]).toEqual({ sumDays: 0.8, count: 2 });
    const otherKey = result.rowKeys.find((r) => r.label === '王五')!.key;
    expect(result.rowTotals[otherKey]).toEqual({ sumDays: 0.8, count: 1 });
  });

  it('透视：行=用户 列=日期，cells/rowTotals/colTotals/grandTotal 结构正确', async () => {
    const { db, dept, group, project, adminUser, selfUser, otherUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(selfUser, project, dept, group, '2026-07-02', 0.3),
      tsRow(otherUser, project, dept, group, '2026-07-01', 0.8),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', colDimension: 'date', measures: ['sumDays'],
    }, { id: adminUser.id, roles: ['admin'] });

    const selfKey = result.rowKeys.find((r) => r.label === '张三')!.key;
    const otherKey = result.rowKeys.find((r) => r.label === '王五')!.key;
    expect(result.cells[selfKey]['2026-07-01']).toEqual({ sumDays: 0.5 });
    expect(result.cells[selfKey]['2026-07-02']).toEqual({ sumDays: 0.3 });
    expect(result.cells[otherKey]['2026-07-01']).toEqual({ sumDays: 0.8 });
    expect(result.rowTotals[selfKey]).toEqual({ sumDays: 0.8 });
    expect(result.rowTotals[otherKey]).toEqual({ sumDays: 0.8 });
    expect(result.colTotals['2026-07-01']).toEqual({ sumDays: 1.3 });
    expect(result.colTotals['2026-07-02']).toEqual({ sumDays: 0.3 });
    expect(result.grandTotal).toEqual({ sumDays: 1.6 });
  });

  it('distinctUsers totals 不可加：用独立 COUNT(DISTINCT) 查询，不等于 cells 累加', async () => {
    const { db, dept, group, project, adminUser, selfUser, otherUser } = await seedBase();
    // 同一日期两个用户 → distinctUsers=2；另一日期仅一人
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(otherUser, project, dept, group, '2026-07-01', 0.8),
      tsRow(selfUser, project, dept, group, '2026-07-02', 0.3),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'date', measures: ['distinctUsers', 'count'],
    }, { id: adminUser.id, roles: ['admin'] });

    expect(result.cells['2026-07-01']['__TOTAL__'].distinctUsers).toBe(2);
    expect(result.cells['2026-07-02']['__TOTAL__'].distinctUsers).toBe(1);
    // grandTotal distinctUsers = 全局去重 = 2（张三 + 王五），而不是 2+1=3
    expect(result.grandTotal.distinctUsers).toBe(2);
    expect(result.grandTotal.count).toBe(3);
  });

  it('可见范围裁剪：仅有 report:custom:view → 只能看到本人数据', async () => {
    const { db, dept, group, project, selfUser, otherUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(otherUser, project, dept, group, '2026-07-01', 0.8),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
    }, { id: selfUser.id, roles: [] }); // selfUser 仅有 report:custom:view

    // 只看到张三自己，看不到王五
    expect(result.rowKeys.map((r) => r.label)).toEqual(['张三']);
    expect(result.grandTotal.sumDays).toBe(0.5);
  });

  it('可见范围裁剪：部门负责人只能看到本部门（不请求过滤时用可访问集作范围）', async () => {
    const { db, dept, otherDept, group, otherGroup, project, deptViewer, selfUser, otherUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(otherUser, project, otherDept, otherGroup, '2026-07-01', 0.8),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
    }, { id: deptViewer.id, roles: [] });

    // 李四是研发部负责人 → 只看到研发部的张三，看不到交付部的王五
    expect(result.rowKeys.map((r) => r.label)).toEqual(['张三']);
    expect(result.grandTotal.sumDays).toBe(0.5);
  });

  it('越权 filter 求交裁剪：请求不可见部门 → 空结果（denyAll）', async () => {
    const { db, dept, otherDept, group, otherGroup, project, deptViewer, selfUser, otherUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(otherUser, project, otherDept, otherGroup, '2026-07-01', 0.8),
    ]);
    const engine = new ReportQueryEngine(db.manager);

    // 李四请求交付部（不可访问）→ 求交为空 → 空结果
    const denied = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
      filters: { departmentIds: [otherDept.id] },
    }, { id: deptViewer.id, roles: [] });
    expect(denied.rowKeys).toEqual([]);
    expect(denied.grandTotal.sumDays).toBe(0);

    // 李四请求研发部（可访问）→ 正常返回研发部数据
    const allowed = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
      filters: { departmentIds: [dept.id] },
    }, { id: deptViewer.id, roles: [] });
    expect(allowed.rowKeys.map((r) => r.label)).toEqual(['张三']);
    expect(allowed.grandTotal.sumDays).toBe(0.5);
  });

  it('status 过滤可显式包含 submitted/draft', async () => {
    const { db, dept, group, project, adminUser, selfUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5, 'approved'),
      tsRow(selfUser, project, dept, group, '2026-07-02', 0.3, 'submitted'),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays', 'count'],
      filters: { statuses: ['approved', 'submitted'] },
    }, { id: adminUser.id, roles: ['admin'] });
    expect(result.grandTotal.sumDays).toBe(0.8);
    expect(result.grandTotal.count).toBe(2);
  });

  it('版本去重：同 (user, project, date) 多版本只计所选状态内最大组号（与报表口径一致）', async () => {
    const { db, dept, group, project, adminUser, selfUser, otherUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      // 张三 07-01：v1 approved 3 天（组 70）+ v2 submitted 5 天（组 71）→ 窗口期并存
      { ...tsRow(selfUser, project, dept, group, '2026-07-01', 3), submissionGroupId: 70 },
      { ...tsRow(selfUser, project, dept, group, '2026-07-01', 5), submissionGroupId: 71, status: 'submitted' },
      // 王五 07-02：独立 approved 2 天（组 72）
      { ...tsRow(otherUser, project, dept, group, '2026-07-02', 2), submissionGroupId: 72 },
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const viewer = { id: adminUser.id, roles: ['admin'] };

    // 默认 approved：只计 v1（3），v2 submitted 不在集合内 → 3 + 2 = 5（修复前为 8 双计）
    const approved = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
    }, viewer);
    expect(approved.grandTotal.sumDays).toBe(5);

    // 显式 submitted：只计 v2（5）
    const submitted = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
      filters: { statuses: ['submitted'] },
    }, viewer);
    expect(submitted.grandTotal.sumDays).toBe(5);

    // 混合 approved + submitted：最新版本视角 = v2（5），v1 不再双计 → 5 + 2 = 7
    const mixed = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays'],
      filters: { statuses: ['approved', 'submitted'] },
    }, viewer);
    expect(mixed.grandTotal.sumDays).toBe(7);
  });

  it('版本去重：新旧版本同为 approved 时只计最大组号（v2 通过后 v1 不双计）', async () => {
    const { db, dept, group, project, adminUser, selfUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      { ...tsRow(selfUser, project, dept, group, '2026-07-01', 3), submissionGroupId: 80 },
      { ...tsRow(selfUser, project, dept, group, '2026-07-01', 4), submissionGroupId: 81 },
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'user', measures: ['sumDays', 'count'],
    }, { id: adminUser.id, roles: ['admin'] });
    expect(result.grandTotal.sumDays).toBe(4);
    expect(result.grandTotal.count).toBe(1);
  });

  it('overtime 源：按 overtimeType 维度聚合正常工作', async () => {
    const { db, dept, group, project, adminUser, selfUser } = await seedBase();
    await db.getRepository(OvertimeApplication).save([
      {
        user: selfUser, userId: selfUser.id, date: '2026-07-04', overtimeType: 'weekend', days: 0.5,
        project, projectId: project.id, status: 'approved',
        departmentSnapshotId: dept.id, departmentSnapshotName: dept.name,
        groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
      {
        user: selfUser, userId: selfUser.id, date: '2026-07-05', overtimeType: 'weekday', days: 0.25,
        project, projectId: project.id, status: 'approved',
        departmentSnapshotId: dept.id, departmentSnapshotName: dept.name,
        groupSnapshotId: group.id, groupSnapshotName: group.name,
      },
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'overtime', startDate: '2026-07-01', endDate: '2026-07-31',
      rowDimension: 'overtimeType', measures: ['sumDays'],
    }, { id: adminUser.id, roles: ['admin'] });
    const labels = result.rowKeys.map((r) => r.label).sort();
    expect(labels).toEqual(['weekday', 'weekend']);
    const weekendKey = result.rowKeys.find((r) => r.label === 'weekend')!.key;
    expect(result.rowTotals[weekendKey].sumDays).toBe(0.5);
  });

  it('month 维度：SUBSTR 跨方言聚合按年月分组', async () => {
    const { db, dept, group, project, adminUser, selfUser } = await seedBase();
    await db.getRepository(Timesheet).save([
      tsRow(selfUser, project, dept, group, '2026-07-01', 0.5),
      tsRow(selfUser, project, dept, group, '2026-07-15', 0.3),
      tsRow(selfUser, project, dept, group, '2026-08-01', 0.2),
    ]);
    const engine = new ReportQueryEngine(db.manager);
    const result = await engine.run({
      source: 'timesheet', startDate: '2026-07-01', endDate: '2026-08-31',
      rowDimension: 'month', measures: ['sumDays'],
    }, { id: adminUser.id, roles: ['admin'] });
    const keys = result.rowKeys.map((r) => r.key).sort();
    expect(keys).toEqual(['2026-07', '2026-08']);
    expect(result.rowTotals['2026-07'].sumDays).toBe(0.8);
    expect(result.rowTotals['2026-08'].sumDays).toBe(0.2);
  });
});
