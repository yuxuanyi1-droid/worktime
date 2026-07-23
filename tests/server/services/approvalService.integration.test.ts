import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { ApprovalInstanceService } from '@server/services/approvalInstanceService';
import { ApprovalService } from '@server/services/approvalService';
import { ApprovalRecord } from '@server/entities/ApprovalRecord';
import { ApprovalTask } from '@server/entities/ApprovalTask';
import { OvertimeApplication } from '@server/entities/OvertimeApplication';
import { Project } from '@server/entities/Project';
import { User } from '@server/entities/User';
import { WeeklyReport } from '@server/entities/WeeklyReport';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('ApprovalService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      { id: 1, username: 'approval-applicant', password: 'hash', realName: '申请人', status: 1, roles: [] },
      { id: 2, username: 'approval-a', password: 'hash', realName: '审批人甲', status: 1, roles: [] },
      { id: 3, username: 'approval-b', password: 'hash', realName: '审批人乙', status: 1, roles: [] },
      { id: 4, username: 'cc-user', password: 'hash', realName: '抄送人', status: 1, roles: [] },
      { id: 5, username: 'disabled-user', password: 'hash', realName: '停用用户', status: 0, roles: [] },
    ]);
  });

  afterEach(teardownTestDb);

  async function createWeeklyApproval() {
    const dataSource = getTestDataSource();
    await new ApprovalFlowEngine(dataSource.manager).createFlow({
      name: '周报默认审批',
      type: 'weekly_report',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '周报审批', customApproverId: 2 }],
    });
    const report = await dataSource.getRepository(WeeklyReport).save({
      userId: 1,
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      content: '本周内容',
      summary: '本周摘要',
      totalDays: 4.5,
      status: 'submitted',
      currentStep: 1,
      totalSteps: 1,
    });
    const started = await dataSource.transaction((manager) => new ApprovalInstanceService(manager).start({
      targetType: 'weekly_report',
      targetId: report.id,
      applicantId: 1,
    }));
    await dataSource.getRepository(WeeklyReport).update(report.id, {
      approvalInstanceId: started.instance.id,
      approvalFlowId: started.instance.flowId,
    });
    return report;
  }

  it('我的申请和审批详情返回真实状态及周报总工时', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);

    const submissions = await service.getMySubmissions(1, { targetType: 'weekly_report' });
    expect(submissions.list).toHaveLength(1);
    expect(submissions.list[0]).toMatchObject({
      targetId: report.id,
      status: 'submitted',
      totalDays: 4.5,
    });

    const detail = await service.getApprovalDetail('weekly_report', report.id, 1);
    expect(detail.content).toMatchObject({ status: 'submitted', totalDays: 4.5 });
    expect(detail.viewerContext).toMatchObject({ isApplicant: true, isCurrentApprover: false });
  });

  it('我的申请在数据库中分页，并支持单边业务日期筛选', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(OvertimeApplication).save(Array.from({ length: 25 }, (_, index) => ({
      userId: 1,
      projectId: null,
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      overtimeType: 'weekday' as const,
      days: 0.5,
      reason: `加班 ${index + 1}`,
      status: 'draft' as const,
      currentStep: 0,
      totalSteps: 0,
    })));

    const result = await new ApprovalService(dataSource.manager).getMySubmissions(1, {
      targetType: 'overtime',
      status: 'draft',
      startDate: '2026-07-06',
      page: 2,
      pageSize: 10,
    });

    expect(result).toMatchObject({ total: 20, page: 2, pageSize: 10 });
    expect(result.list).toHaveLength(10);
    expect(result.list.every(item => item.status === 'draft' && item.date >= '2026-07-06')).toBe(true);
  });

  it('会签仅部分通过时仍展示为当前步骤，全部通过后才完成', async () => {
    const dataSource = getTestDataSource();
    const managers = await dataSource.getRepository(User).findByIds([2, 3]);
    const project = await dataSource.getRepository(Project).save({
      name: '会签项目',
      code: 'APPROVAL-COUNTERSIGN',
      status: 'active',
      managers,
    });
    await new ApprovalFlowEngine(dataSource.manager).createFlow({
      name: '加班会签审批',
      type: 'overtime',
      isDefault: true,
      steps: [{
        stepType: 'project_manager',
        label: '项目管理员会签',
        requireAllApprovers: true,
      }],
    });
    const overtime = await dataSource.getRepository(OvertimeApplication).save({
      userId: 1,
      projectId: project.id,
      date: '2026-07-22',
      overtimeType: 'weekday',
      days: 0.5,
      reason: '版本发布',
      status: 'submitted',
      currentStep: 1,
      totalSteps: 1,
    });
    const started = await dataSource.transaction((manager) => new ApprovalInstanceService(manager).start({
      targetType: 'overtime',
      targetId: overtime.id,
      applicantId: 1,
      projectId: project.id,
    }));
    await dataSource.getRepository(OvertimeApplication).update(overtime.id, {
      approvalInstanceId: started.instance.id,
      approvalFlowId: started.instance.flowId,
    });

    await dataSource.transaction((manager) => new ApprovalService(manager).approve(2, '审批人甲', [{
      targetType: 'overtime',
      targetId: overtime.id,
      action: 'approve',
      comment: '同意',
    }]));

    const partial = await new ApprovalService(dataSource.manager).getApprovalDetail('overtime', overtime.id, 1);
    expect(partial.content.status).toBe('submitted');
    expect(partial.flowSteps[0].status).toBe('current');
    expect(partial.flowSteps[0].approverStatuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 2, status: 'approved' }),
      expect.objectContaining({ id: 3, status: 'pending' }),
    ]));

    await dataSource.transaction((manager) => new ApprovalService(manager).approve(3, '审批人乙', [{
      targetType: 'overtime',
      targetId: overtime.id,
      action: 'approve',
    }]));
    const completed = await new ApprovalService(dataSource.manager).getApprovalDetail('overtime', overtime.id, 1);
    expect(completed.content.status).toBe('approved');
    expect(completed.flowSteps[0].status).toBe('approved');
  });

  it('驳回必须填写原因，且校验失败不会改变审批状态', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();

    await expect(dataSource.transaction((manager) => new ApprovalService(manager).approve(2, '审批人甲', [{
      targetType: 'weekly_report',
      targetId: report.id,
      action: 'reject',
      comment: '   ',
    }]))).rejects.toThrow('驳回时必须填写原因');

    expect(await dataSource.getRepository(WeeklyReport).findOneByOrFail({ id: report.id }))
      .toMatchObject({ status: 'submitted', currentStep: 1 });
    expect(await dataSource.getRepository(ApprovalRecord).count()).toBe(0);
    expect(await dataSource.getRepository(ApprovalTask).findOneByOrFail({ targetId: report.id }))
      .toMatchObject({ status: 'pending' });
  });

  it('抄送去重、拒绝自己和停用用户，并避免重复生成传阅记录', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);

    await expect(service.cc(1, '申请人', 'weekly_report', report.id, [1, 1]))
      .rejects.toThrow('至少一名其他用户');
    await expect(service.cc(1, '申请人', 'weekly_report', report.id, [5]))
      .rejects.toThrow('不存在或已被禁用');

    await expect(service.cc(1, '申请人', 'weekly_report', report.id, [4, 4]))
      .resolves.toMatchObject({ success: true, createdCount: 1 });
    expect(await dataSource.getRepository(ApprovalRecord).countBy({ action: 'cc' })).toBe(1);
    await expect(service.cc(1, '申请人', 'weekly_report', report.id, [4]))
      .rejects.toThrow('均已收到过');
    expect(await dataSource.getRepository(ApprovalRecord).countBy({ action: 'cc' })).toBe(1);
  });

  it('已处理审批历史直接使用数据库分页', async () => {
    const dataSource = getTestDataSource();
    await dataSource.getRepository(ApprovalRecord).save([
      ...Array.from({ length: 25 }, (_, index) => ({
      targetType: 'weekly_report' as const,
      targetId: index + 1,
      instanceId: null,
      taskId: null,
      approverId: 2,
      approverName: '审批人甲',
      action: index % 2 === 0 ? 'approve' as const : 'reject' as const,
      comment: `处理 ${index + 1}`,
      stepOrder: 1,
      stepType: 'custom',
      stepLabel: '负责人审批',
      })),
      {
        targetType: 'weekly_report' as const, targetId: 100, instanceId: null, taskId: null,
        approverId: 3, approverName: '审批人乙', action: 'approve' as const, comment: '他人处理',
        stepOrder: 1, stepType: 'custom', stepLabel: '负责人审批',
      },
      {
        targetType: 'weekly_report' as const, targetId: 101, instanceId: null, taskId: null,
        approverId: 2, approverName: '审批人甲', action: 'cc' as const, comment: '抄送记录',
        stepOrder: 0, stepType: 'cc', stepLabel: '抄送传阅',
      },
    ]);

    const result = await new ApprovalService(dataSource.manager).getApprovalHistory({
      viewerId: 2,
      page: 2,
      pageSize: 10,
    });

    expect(result).toMatchObject({ total: 25, page: 2, pageSize: 10 });
    expect(result.list).toHaveLength(10);
    expect(result.list.every(record => record.approverId === 2)).toBe(true);
  });

  it('待办列表只返回实际分配给审批人的已提交记录', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);
    const pending = await service.getPendingList(2, { targetType: 'weekly_report', page: 1, pageSize: 10 });
    expect(pending).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(pending.list).toEqual([
      expect.objectContaining({
        targetType: 'weekly_report', targetId: report.id, applicant: '申请人',
        status: 'submitted', currentStepLabel: '周报审批', currentStepApproverIds: [2],
      }),
    ]);
    await expect(service.getPendingList(3, { targetType: 'weekly_report' }))
      .resolves.toMatchObject({ list: [], total: 0 });
  });

  it('合法驳回原子更新任务、实例、业务状态和审批记录', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    await dataSource.transaction((manager) => new ApprovalService(manager).approve(2, '审批人甲', [{
      targetType: 'weekly_report', targetId: report.id, action: 'reject', comment: '请补充风险说明',
    }]));
    expect(await dataSource.getRepository(WeeklyReport).findOneByOrFail({ id: report.id }))
      .toMatchObject({ status: 'rejected', currentStep: 0 });
    expect(await dataSource.getRepository(ApprovalTask).findOneByOrFail({ targetId: report.id, approverId: 2 }))
      .toMatchObject({ status: 'rejected', action: 'reject', comment: '请补充风险说明' });
    expect(await dataSource.getRepository(ApprovalRecord).findOneByOrFail({ targetId: report.id, approverId: 2 }))
      .toMatchObject({ action: 'reject', comment: '请补充风险说明' });
  });

  it('批量审批拒绝空数组、重复目标和非待审批记录', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);
    await expect(service.approve(2, '审批人甲', [])).rejects.toThrow('请选择需要审批');
    await expect(service.approve(2, '审批人甲', [
      { targetType: 'weekly_report', targetId: report.id, action: 'approve' },
      { targetType: 'weekly_report', targetId: report.id, action: 'approve' },
    ])).rejects.toThrow('审批记录重复');
    await dataSource.getRepository(WeeklyReport).update(report.id, { status: 'withdrawn' });
    await expect(service.approve(2, '审批人甲', [{
      targetType: 'weekly_report', targetId: report.id, action: 'approve',
    }])).rejects.toThrow('不是待审批状态');
  });

  it('申请人撤回后同步关闭审批任务并保留可审计记录', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    await expect(new ApprovalService(dataSource.manager).withdraw(1, 'weekly_report', report.id))
      .resolves.toEqual({ success: true });
    expect(await dataSource.getRepository(WeeklyReport).findOneByOrFail({ id: report.id }))
      .toMatchObject({ status: 'withdrawn', currentStep: 0, approvalFlowId: null, approvalInstanceId: null });
    expect(await dataSource.getRepository(ApprovalTask).findOneByOrFail({ targetId: report.id }))
      .toMatchObject({ status: 'withdrawn' });
    expect(await dataSource.getRepository(ApprovalRecord).findOneByOrFail({ targetId: report.id, action: 'withdraw' }))
      .toMatchObject({ approverId: 1, approverName: '申请人' });
  });

  it('撤回严格校验存在性、所有权和审批状态', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);
    await expect(service.withdraw(1, 'weekly_report', 999)).rejects.toThrow('记录不存在');
    await expect(service.withdraw(3, 'weekly_report', report.id)).rejects.toThrow('只能撤回自己的申请');
    await dataSource.getRepository(WeeklyReport).update(report.id, { status: 'approved' });
    await expect(service.withdraw(1, 'weekly_report', report.id)).rejects.toThrow('只能撤回审批中的申请');
  });

  it('抄送列表仅返回当前收件人的有效目标和申请人信息', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);
    await service.cc(1, '申请人', 'weekly_report', report.id, [4]);
    const result = await service.getMyCcList(4, { page: 1, pageSize: 10 });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(result.list).toEqual([
      expect.objectContaining({
        targetType: 'weekly_report', targetId: report.id, applicant: '申请人',
        ccFrom: '申请人', status: 'submitted',
      }),
    ]);
    await expect(service.getMyCcList(3, { page: 1, pageSize: 10 }))
      .resolves.toMatchObject({ list: [], total: 0 });
  });

  it('审批详情只对申请人、实际审批人、抄送人或管理员开放', async () => {
    const dataSource = getTestDataSource();
    const report = await createWeeklyApproval();
    const service = new ApprovalService(dataSource.manager);
    await expect(service.getApprovalDetail('weekly_report', report.id, 3))
      .rejects.toThrow('无权查看该审批详情');
    await expect(service.getApprovalDetail('weekly_report', report.id, 2))
      .resolves.toMatchObject({ viewerContext: { isApplicant: false, isCurrentApprover: true } });
    await service.cc(1, '申请人', 'weekly_report', report.id, [4]);
    await expect(service.getApprovalDetail('weekly_report', report.id, 4))
      .resolves.toMatchObject({ viewerContext: { isCcRecipient: true } });
  });
});
