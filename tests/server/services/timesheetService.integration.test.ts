import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { TimesheetService } from '@server/services/timesheetService';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
import { ApprovalTask } from '@server/entities/ApprovalTask';
import { Project } from '@server/entities/Project';
import { Timesheet } from '@server/entities/Timesheet';
import { User } from '@server/entities/User';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('TimesheetService 提交审批集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      { id: 1, username: 'timesheet-user', password: 'hash', realName: '工时用户', status: 1, roles: [] },
      { id: 2, username: 'timesheet-approver', password: 'hash', realName: '工时审批人', status: 1, roles: [] },
    ]);
    await dataSource.getRepository(Project).save([
      { id: 1, name: '进行中项目', code: 'TS-ACTIVE', status: 'active', managers: [] },
      { id: 2, name: '已中止项目', code: 'TS-STOPPED', status: 'suspended', managers: [] },
      { id: 3, name: '第二进行中项目', code: 'TS-ACTIVE-2', status: 'active', managers: [] },
    ]);
  });

  afterEach(teardownTestDb);

  async function createDefaultFlow() {
    await new ApprovalFlowEngine(getTestDataSource().manager).createFlow({
      name: '工时默认审批',
      type: 'timesheet',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '负责人审批', customApproverId: 2 }],
    });
  }

  async function createDraft(projectId = 1) {
    return getTestDataSource().getRepository(Timesheet).save({
      userId: 1,
      projectId,
      date: '2026-07-20',
      days: 1,
      description: '开发任务',
      status: 'draft',
      currentStep: 0,
      totalSteps: 0,
    });
  }

  it('提交前预检审批配置，缺少流程时保持草稿状态', async () => {
    const dataSource = getTestDataSource();
    const draft = await createDraft();
    const service = new TimesheetService(dataSource.manager);

    await expect(service.submit([draft.id], 1)).rejects.toThrow('未配置可用的默认审批流程');
    expect((await dataSource.getRepository(Timesheet).findOneByOrFail({ id: draft.id })).status).toBe('draft');
    expect(await dataSource.getRepository(ApprovalInstance).count()).toBe(0);
  });

  it('有效提交会同步创建审批实例和当前步骤任务', async () => {
    const dataSource = getTestDataSource();
    await createDefaultFlow();
    const draft = await createDraft();

    await new TimesheetService(dataSource.manager).submit([draft.id], 1);
    const submitted = await dataSource.getRepository(Timesheet).findOneByOrFail({ id: draft.id });
    expect(submitted).toMatchObject({ status: 'submitted', currentStep: 1, totalSteps: 1 });
    expect(submitted.approvalInstanceId).toBeTruthy();
    expect(await dataSource.getRepository(ApprovalTask).findOneByOrFail({
      instanceId: submitted.approvalInstanceId!,
      approverId: 2,
    })).toMatchObject({ status: 'pending', stepOrder: 1 });
  });

  it('拒绝不存在记录、停用项目和全零行提交', async () => {
    const dataSource = getTestDataSource();
    await createDefaultFlow();
    const stoppedDraft = await createDraft(2);
    const service = new TimesheetService(dataSource.manager);

    await expect(service.submit([999], 1)).rejects.toThrow('包含不存在的工时记录');
    await expect(service.submit([stoppedDraft.id], 1)).rejects.toThrow('已非进行中状态');
    await expect(service.submitByRows(1, [{
      projectId: 1,
      description: '空提交',
      weekStart: '2026-07-20',
      entries: [{ date: '2026-07-20', days: 0 }],
    }])).rejects.toThrow('至少填写一条大于 0');
  });

  it('工时列表的单边日期筛选不会被静默忽略', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(Timesheet).save([
      {
        userId: 1, projectId: 1, date: '2026-07-01', days: 1,
        description: '月初任务', status: 'draft', currentStep: 0, totalSteps: 0,
      },
      {
        userId: 1, projectId: 1, date: '2026-07-20', days: 1,
        description: '月底任务', status: 'draft', currentStep: 0, totalSteps: 0,
      },
    ]);
    const service = new TimesheetService(dataSource.manager);

    const fromMiddle = await service.getByUser(1, { startDate: '2026-07-10' });
    expect(fromMiddle.list.map((item) => item.date)).toEqual(['2026-07-20']);

    const untilMiddle = await service.getByUser(1, { endDate: '2026-07-10' });
    expect(untilMiddle.list.map((item) => item.date)).toEqual(['2026-07-01']);
  });

  it('整周草稿替换为原子操作，新数据校验失败时保留旧草稿', async () => {
    const dataSource = getTestDataSource();
    const oldDraft = await dataSource.getRepository(Timesheet).save({
      userId: 1, projectId: 1, date: '2026-07-20', days: 0.5,
      description: '保留的旧草稿', status: 'draft', currentStep: 0, totalSteps: 0,
    });
    const service = new TimesheetService(dataSource.manager);

    await expect(service.replaceWeekDrafts(1, '2026-07-20', [{
      projectId: 2, date: '2026-07-20', days: 0.5, description: '停用项目',
    }])).rejects.toThrow('已非进行中状态');
    expect(await dataSource.getRepository(Timesheet).findOneBy({ id: oldDraft.id })).not.toBeNull();

    const saved = await service.replaceWeekDrafts(1, '2026-07-20', [{
      projectId: 1, date: '2026-07-21', days: 0.5, description: '新草稿',
    }]);
    expect(saved).toHaveLength(1);
    expect(await dataSource.getRepository(Timesheet).findOneBy({ id: oldDraft.id })).toBeNull();
    expect((await dataSource.getRepository(Timesheet).findBy({ userId: 1, status: 'draft' })))
      .toEqual([expect.objectContaining({ date: '2026-07-21', description: '新草稿' })]);
  });

  it('整周草稿拒绝跨周日期和单日超额', async () => {
    const service = new TimesheetService(getTestDataSource().manager);
    await expect(service.replaceWeekDrafts(1, '2026-07-20', [{
      projectId: 1, date: '2026-07-27', days: 0.5,
    }])).rejects.toThrow('必须在指定周内');

    await expect(service.replaceWeekDrafts(1, '2026-07-20', [
      { projectId: 1, date: '2026-07-20', days: 1 },
      { projectId: 3, date: '2026-07-20', days: 0.5 },
    ])).rejects.toThrow('超过每日1天上限');

    await expect(service.replaceWeekDrafts(1, '2026-07-20', [
      { projectId: 1, date: '2026-07-20', days: 0.5 },
      { projectId: 1, date: '2026-07-20', days: 0.5 },
    ])).rejects.toThrow('存在重复工时');
  });

  it('局部修改只版本化载荷中的项目，并废弃该项目被清空的日期', async () => {
    const dataSource = getTestDataSource();
    await createDefaultFlow();
    const oldRows = await dataSource.getRepository(Timesheet).save([
      {
        userId: 1, projectId: 1, date: '2026-07-20', days: 0.5,
        description: '项目一旧版', status: 'approved', currentStep: 0, totalSteps: 1,
        submissionGroupId: 10, rootGroupId: 10,
      },
      {
        userId: 1, projectId: 1, date: '2026-07-21', days: 0.5,
        description: '项目一旧版', status: 'approved', currentStep: 0, totalSteps: 1,
        submissionGroupId: 10, rootGroupId: 10,
      },
      {
        userId: 1, projectId: 3, date: '2026-07-22', days: 1,
        description: '未修改项目', status: 'approved', currentStep: 0, totalSteps: 1,
        submissionGroupId: 11, rootGroupId: 11,
      },
    ]);

    await new TimesheetService(dataSource.manager).modifySubmitted(1, [{
      projectId: 1,
      description: '项目一新版',
      weekStart: '2026-07-20',
      entries: [{ date: '2026-07-20', days: 0.5 }],
    }]);

    const stored = await dataSource.getRepository(Timesheet).find({ order: { id: 'ASC' } });
    expect(stored.find(row => row.id === oldRows[0].id)?.status).toBe('deprecated');
    expect(stored.find(row => row.id === oldRows[1].id)?.status).toBe('deprecated');
    expect(stored.find(row => row.id === oldRows[2].id)).toMatchObject({
      status: 'approved', description: '未修改项目',
    });
    expect(stored).toContainEqual(expect.objectContaining({
      projectId: 1,
      date: '2026-07-20',
      description: '项目一新版',
      status: 'submitted',
      previousGroupId: 10,
      rootGroupId: 10,
    }));
  });

  it('按行提交拒绝非周一、跨周日期、混合周次和重复项目行', async () => {
    const service = new TimesheetService(getTestDataSource().manager);
    const baseRow = {
      projectId: 1,
      description: '开发任务',
      weekStart: '2026-07-20',
      entries: [{ date: '2026-07-20', days: 0.5 }],
    };

    await expect(service.submitByRows(1, [{ ...baseRow, weekStart: '2026-07-21' }]))
      .rejects.toThrow('weekStart必须是周一');
    await expect(service.submitByRows(1, [{ ...baseRow, entries: [{ date: '2026-07-27', days: 0.5 }] }]))
      .rejects.toThrow('必须在指定周内');
    await expect(service.submitByRows(1, [baseRow, { ...baseRow, projectId: 3, weekStart: '2026-07-27' }]))
      .rejects.toThrow('一次只能提交同一周');
    await expect(service.submitByRows(1, [baseRow, { ...baseRow, entries: [{ date: '2026-07-21', days: 0.5 }] }]))
      .rejects.toThrow('同一项目在一周内只能提交一行');
  });

  it('创建和批量创建会校验项目、填报步长、重复项及每日上限', async () => {
    const service = new TimesheetService(getTestDataSource().manager);

    await expect(service.create({
      userId: 1, projectId: 999, date: '2026-07-20', days: 0.5,
    })).rejects.toThrow('包含不存在的项目');
    await expect(service.create({
      userId: 1, projectId: 2, date: '2026-07-20', days: 0.5,
    })).rejects.toThrow('已非进行中状态');
    await expect(service.create({
      userId: 1, projectId: 1, date: '2026-07-20', days: 0.3,
    })).rejects.toThrow('不是填报单位 0.5 天的整数倍');

    const created = await service.create({
      userId: 1, projectId: 1, date: '2026-07-20', days: 0.5, description: '单条草稿',
    });
    expect(created).toMatchObject({ userId: 1, projectId: 1, status: 'draft', description: '单条草稿' });

    await expect(service.batchCreate(1, [
      { projectId: 1, date: '2026-07-21', days: 0.5 },
      { projectId: 1, date: '2026-07-21', days: 0.5 },
    ])).rejects.toThrow('存在重复工时');
    await expect(service.batchCreate(1, [
      { projectId: 1, date: '2026-07-21', days: 1 },
      { projectId: 3, date: '2026-07-21', days: 0.5 },
    ])).rejects.toThrow('超过每日1天上限');

    const batch = await service.batchCreate(1, [
      { projectId: 1, date: '2026-07-21', days: 0.5, description: '项目一' },
      { projectId: 3, date: '2026-07-21', days: 0.5, description: '项目二' },
    ]);
    expect(batch).toHaveLength(2);
  });

  it('草稿修改和删除严格校验归属、状态与目标项目', async () => {
    const dataSource = getTestDataSource();
    const service = new TimesheetService(dataSource.manager);
    const draft = await createDraft();
    const foreign = await dataSource.getRepository(Timesheet).save({
      userId: 2, projectId: 1, date: '2026-07-21', days: 0.5,
      status: 'draft', currentStep: 0, totalSteps: 0,
    });
    const submitted = await dataSource.getRepository(Timesheet).save({
      userId: 1, projectId: 1, date: '2026-07-22', days: 0.5,
      status: 'submitted', currentStep: 1, totalSteps: 1,
    });

    await expect(service.update(999, 1, { days: 0.5 })).rejects.toThrow('记录不存在');
    await expect(service.update(foreign.id, 1, { days: 0.5 })).rejects.toThrow('只能修改自己的');
    await expect(service.update(submitted.id, 1, { days: 0.5 })).rejects.toThrow('仅草稿状态可修改');
    await expect(service.update(draft.id, 1, { projectId: 2 })).rejects.toThrow('已非进行中状态');
    await expect(service.update(draft.id, 1, { days: 0.3 })).rejects.toThrow('不是填报单位');

    await expect(service.update(draft.id, 1, {
      projectId: 3, days: 0.5, description: '已更新',
    })).resolves.toMatchObject({ projectId: 3, description: '已更新' });
    await expect(service.delete(foreign.id, 1)).rejects.toThrow('只能删除自己的');
    await expect(service.delete(submitted.id, 1)).rejects.toThrow('仅草稿状态可删除');
    await expect(service.delete(draft.id, 1)).resolves.toMatchObject({ affected: 1 });
    expect(await dataSource.getRepository(Timesheet).findOneBy({ id: draft.id })).toBeNull();
  });

  it('日期范围、周汇总和修改链只计算最新有效版本', async () => {
    const dataSource = getTestDataSource();
    const records = await dataSource.getRepository(Timesheet).save([
      {
        userId: 1, projectId: 1, date: '2026-07-20', days: 0.5, description: '旧版',
        status: 'deprecated', currentStep: 0, totalSteps: 1,
        submissionGroupId: 10, rootGroupId: 10,
      },
      {
        userId: 1, projectId: 1, date: '2026-07-20', days: 1, description: '新版',
        status: 'approved', currentStep: 0, totalSteps: 1,
        submissionGroupId: 11, previousGroupId: 10, rootGroupId: 10,
      },
      {
        userId: 1, projectId: 3, date: '2026-07-21', days: 0.5, description: '第二项目',
        status: 'approved', currentStep: 0, totalSteps: 1,
        submissionGroupId: 12, rootGroupId: 12,
      },
      {
        userId: 1, projectId: 3, date: '2026-07-22', days: 0.5, description: '已撤回',
        status: 'withdrawn', currentStep: 0, totalSteps: 1,
        submissionGroupId: 13, rootGroupId: 13,
      },
    ]);
    const service = new TimesheetService(dataSource.manager);

    const range = await service.getByDateRange(1, '2026-07-20', '2026-07-26');
    expect(range.map(row => row.id)).toEqual([records[1].id, records[2].id]);

    const summary = await service.getWeeklySummary(1, '2026-07-20', '2026-07-26');
    expect(summary.totalDays).toBe(1.5);
    expect(summary.byProject).toEqual({ '进行中项目': 1, '第二进行中项目': 0.5 });

    const chain = await service.getModificationChain(records[0].id);
    expect(chain.rootGroupId).toBe(10);
    expect(chain.groups).toHaveLength(2);
    expect(chain.groups.map(group => group.submissionGroupId)).toEqual([10, 11]);
    expect(chain.groups[1]).toMatchObject({ previousGroupId: 10, totalDays: 1, description: '新版' });
    await expect(service.getModificationChain(999)).rejects.toThrow('记录不存在');

    const draft = await createDraft();
    expect(await service.getModificationChain(draft.id)).toEqual({ rootGroupId: null, groups: [] });
  });
});
