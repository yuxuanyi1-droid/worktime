import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
import { OvertimeApplication } from '@server/entities/OvertimeApplication';
import { Project } from '@server/entities/Project';
import { User } from '@server/entities/User';
import { OvertimeService } from '@server/services/overtimeService';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { BusinessError } from '@server/utils/errors';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('OvertimeService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      {
        id: 1,
        username: 'overtime-user',
        password: 'test-password-hash',
        realName: '加班用户',
      },
      {
        id: 2,
        username: 'overtime-approver',
        password: 'test-password-hash',
        realName: '加班审批人',
      },
    ]);
    await dataSource.getRepository(Project).save([
      { id: 1, name: '有效项目', code: 'ACTIVE', status: 'active' },
      { id: 2, name: '停用项目', code: 'STOPPED', status: 'suspended' },
    ]);
    await new ApprovalFlowEngine(dataSource.manager).createFlow({
      name: '加班默认审批',
      type: 'overtime',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '审批人审批', customApproverId: 2 }],
    });
  });

  afterEach(teardownTestDb);

  async function rejectedRecord() {
    const dataSource = getTestDataSource();
    const record = await dataSource.getRepository(OvertimeApplication).save({
      userId: 1,
      projectId: 1,
      date: '2026-07-20',
      overtimeType: 'weekday',
      days: 0.5,
      reason: '旧原因',
      status: 'rejected',
      currentStep: 1,
      totalSteps: 1,
    });
    const instance = await dataSource.getRepository(ApprovalInstance).save({
      targetType: 'overtime',
      targetId: record.id,
      applicantId: 1,
      status: 'rejected',
      currentStepOrder: null,
      totalSteps: 1,
      flowId: null,
      flowVersionId: null,
      flowName: '旧审批',
      flowVersionNumber: 1,
      stepsSnapshot: [],
      quotaSnapshot: null,
      submittedAt: new Date(),
      finishedAt: new Date(),
    });
    record.approvalInstanceId = instance.id;
    return dataSource.getRepository(OvertimeApplication).save(record);
  }

  it('驳回记录修改后可重提，并保留两次审批实例', async () => {
    const dataSource = getTestDataSource();
    const service = new OvertimeService(dataSource.manager);
    const record = await rejectedRecord();

    const draft = await service.update(record.id, 1, {
      date: '2026-07-21',
      projectId: 1,
      overtimeType: 'weekday',
      days: 1,
      reason: '修改后的原因',
    });
    expect(draft).toMatchObject({ status: 'draft', approvalInstanceId: null, currentStep: 0 });

    await service.submit([record.id], 1);
    const submitted = await dataSource.getRepository(OvertimeApplication).findOneByOrFail({ id: record.id });
    expect(submitted.status).toBe('submitted');
    expect(await dataSource.getRepository(ApprovalInstance).countBy({ targetType: 'overtime', targetId: record.id })).toBe(2);
  });

  it('拒绝停用项目和不存在的批量提交记录', async () => {
    const service = new OvertimeService(getTestDataSource().manager);
    const record = await rejectedRecord();

    await expect(service.update(record.id, 1, { projectId: 2 })).rejects.toBeInstanceOf(BusinessError);
    await expect(service.submit([record.id, 999], 1)).rejects.toMatchObject({
      message: '部分加班记录不存在，请刷新列表后重试',
    });
  });

  it('支持仅设置起始或结束日期的列表筛选', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(OvertimeApplication).save([
      { userId: 1, projectId: 1, date: '2026-07-01', overtimeType: 'weekday', days: 0.5, status: 'approved' },
      { userId: 1, projectId: 1, date: '2026-07-20', overtimeType: 'weekend', days: 1, status: 'approved' },
    ]);
    const service = new OvertimeService(dataSource.manager);

    const after = await service.getByUser(1, { startDate: '2026-07-10' });
    const before = await service.getByUser(1, { endDate: '2026-07-10' });
    expect(after.list.map((item) => item.date)).toEqual(['2026-07-20']);
    expect(before.list.map((item) => item.date)).toEqual(['2026-07-01']);
  });

  it('创建草稿和创建后立即提交都会校验进行中项目并保存组织快照', async () => {
    const dataSource = getTestDataSource();
    const service = new OvertimeService(dataSource.manager);

    await expect(service.create({
      userId: 1, projectId: 2, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
    })).rejects.toThrow('加班项目不存在或已停用');
    await expect(service.create({
      userId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
    })).rejects.toThrow('请选择加班项目');

    const draft = await service.create({
      userId: 1, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5, reason: '发布准备',
    });
    expect(draft).toMatchObject({ userId: 1, projectId: 1, status: 'draft', reason: '发布准备' });

    const submitted = await service.createAndSubmit({
      userId: 1, projectId: 1, date: '2026-07-21', overtimeType: 'weekday', days: 1, reason: '线上支持',
    });
    expect(submitted).toMatchObject({ userId: 1, status: 'submitted', currentStep: 1 });
    expect(submitted?.approvalInstanceId).toBeTruthy();
  });

  it('草稿修改和删除严格校验记录归属、状态与项目有效性', async () => {
    const dataSource = getTestDataSource();
    const service = new OvertimeService(dataSource.manager);
    const draft = await service.create({
      userId: 1, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5, reason: '旧原因',
    });
    const foreign = await dataSource.getRepository(OvertimeApplication).save({
      userId: 2, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
      status: 'draft', currentStep: 0, totalSteps: 0,
    });
    const approved = await dataSource.getRepository(OvertimeApplication).save({
      userId: 1, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
      status: 'approved', currentStep: 0, totalSteps: 1,
    });

    await expect(service.update(999, 1, { reason: 'x' })).rejects.toThrow('记录不存在');
    await expect(service.update(foreign.id, 1, { reason: 'x' })).rejects.toThrow('只能修改自己的');
    await expect(service.update(approved.id, 1, { reason: 'x' })).rejects.toThrow('不可修改');
    await expect(service.update(draft.id, 1, { projectId: 2 })).rejects.toThrow('已停用');
    await expect(service.update(draft.id, 1, {
      date: '2026-07-22', overtimeType: 'weekend', days: 1, reason: '新原因', projectId: 1,
    })).resolves.toMatchObject({ date: '2026-07-22', overtimeType: 'weekend', days: 1, reason: '新原因' });

    await expect(service.delete(999, 1)).rejects.toThrow('记录不存在');
    await expect(service.delete(foreign.id, 1)).rejects.toThrow('只能删除自己的');
    await expect(service.delete(approved.id, 1)).rejects.toThrow('仅草稿状态可删除');
    await expect(service.delete(draft.id, 1)).resolves.toMatchObject({ affected: 1 });
  });

  it('批量提交会去重 ID，并拒绝空列表、越权记录和非草稿记录', async () => {
    const dataSource = getTestDataSource();
    const service = new OvertimeService(dataSource.manager);
    const own = await service.create({
      userId: 1, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
    });
    const foreign = await dataSource.getRepository(OvertimeApplication).save({
      userId: 2, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 0.5,
      status: 'draft', currentStep: 0, totalSteps: 0,
    });
    const approved = await dataSource.getRepository(OvertimeApplication).save({
      userId: 1, projectId: 1, date: '2026-07-21', overtimeType: 'weekday', days: 0.5,
      status: 'approved', currentStep: 0, totalSteps: 1,
    });

    await expect(service.submit([], 1)).rejects.toThrow('请选择要提交的记录');
    await expect(service.submit([foreign.id], 1)).rejects.toThrow('只能提交自己的');
    await expect(service.submit([approved.id], 1)).rejects.toThrow('不是草稿状态');
    await expect(service.submit([own.id, own.id], 1)).resolves.toBe(true);
    expect((await dataSource.getRepository(OvertimeApplication).findOneByOrFail({ id: own.id })).status).toBe('submitted');
    expect(await dataSource.getRepository(ApprovalInstance).countBy({ targetType: 'overtime', targetId: own.id })).toBe(1);
  });

  it('加班统计只聚合指定年月内已通过记录', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(OvertimeApplication).save([
      { userId: 1, projectId: 1, date: '2026-07-01', overtimeType: 'weekday', days: 0.5, status: 'approved' },
      { userId: 1, projectId: 1, date: '2026-07-20', overtimeType: 'weekday', days: 1, status: 'approved' },
      { userId: 1, projectId: 1, date: '2026-07-21', overtimeType: 'weekend', days: 1, status: 'approved' },
      { userId: 1, projectId: 1, date: '2026-07-22', overtimeType: 'holiday', days: 1, status: 'draft' },
      { userId: 1, projectId: 1, date: '2026-08-01', overtimeType: 'weekday', days: 2, status: 'approved' },
      { userId: 2, projectId: 1, date: '2026-07-15', overtimeType: 'weekday', days: 3, status: 'approved' },
    ]);

    const result = await new OvertimeService(dataSource.manager).getStats(1, 2026, 7);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'weekday', totalDays: expect.anything(), count: expect.anything() }),
      expect.objectContaining({ type: 'weekend', totalDays: expect.anything(), count: expect.anything() }),
    ]));
    const normalized = Object.fromEntries(result.map(row => [row.type, {
      totalDays: Number(row.totalDays), count: Number(row.count),
    }]));
    expect(normalized).toEqual({ weekday: { totalDays: 1.5, count: 2 }, weekend: { totalDays: 1, count: 1 } });
  });
});
