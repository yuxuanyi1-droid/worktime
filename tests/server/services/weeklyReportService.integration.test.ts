import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Project } from '@server/entities/Project';
import { Timesheet } from '@server/entities/Timesheet';
import { User } from '@server/entities/User';
import { WeeklyReport } from '@server/entities/WeeklyReport';
import { WeeklyReportService } from '@server/services/weeklyReportService';
import { ApprovalFlowEngine } from '@server/services/approvalFlowService';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
import { ApprovalTask } from '@server/entities/ApprovalTask';
import { BusinessError } from '@server/utils/errors';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

describe('WeeklyReportService 集成', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      {
        id: 1,
        username: 'weekly-user',
        password: 'test-password-hash',
        realName: '周报用户',
      },
      {
        id: 2,
        username: 'weekly-approver',
        password: 'test-password-hash',
        realName: '周报审批人',
      },
    ]);
    await dataSource.getRepository(Project).save({
      id: 1,
      name: '工时项目',
      code: 'WT',
      status: 'active',
    });
    await dataSource.getRepository(Timesheet).save([
      { userId: 1, projectId: 1, date: '2026-07-20', days: 0.5, status: 'approved', submissionGroupId: 1 },
      { userId: 1, projectId: 1, date: '2026-07-21', days: 0.5, status: 'submitted', submissionGroupId: 1 },
    ]);
  });

  afterEach(teardownTestDb);

  it('总工时取服务端工时汇总，不信任客户端提交值', async () => {
    const dataSource = getTestDataSource();
    const service = new WeeklyReportService(dataSource.manager);

    const report = await service.createOrUpdate({
      userId: 1,
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      content: '本周完成审批优化',
      summary: '审批优化',
      totalDays: 7,
    });

    expect(Number(report.totalDays)).toBe(1);
  });

  it.each(['rejected', 'withdrawn'] as const)('允许 %s 周报修改后恢复为草稿', async (status) => {
    const dataSource = getTestDataSource();
    const service = new WeeklyReportService(dataSource.manager);
    const repo = dataSource.getRepository(WeeklyReport);
    const original = await service.createOrUpdate({
      userId: 1,
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      content: '旧内容',
    });
    await repo.update(original.id, {
      status,
      currentStep: 2,
      approvalFlowId: null,
      approvalInstanceId: 9,
      totalSteps: 3,
    });

    const updated = await service.createOrUpdate({
      userId: 1,
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      content: '修改后的内容',
    });

    expect(updated).toMatchObject({
      id: original.id,
      status: 'draft',
      currentStep: 0,
      approvalFlowId: null,
      approvalInstanceId: null,
      totalSteps: 0,
      content: '修改后的内容',
    });
  });

  it('拒绝非周一开始或不足七天的周期', async () => {
    const service = new WeeklyReportService(getTestDataSource().manager);

    await expect(service.createOrUpdate({
      userId: 1,
      weekStart: '2026-07-21',
      weekEnd: '2026-07-26',
      content: '错误周期',
    })).rejects.toBeInstanceOf(BusinessError);
  });

  it('空周报不能提交审批', async () => {
    const dataSource = getTestDataSource();
    const report = await dataSource.getRepository(WeeklyReport).save({
      userId: 1,
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      content: '   ',
      summary: '',
      totalDays: 1,
      status: 'draft',
      currentStep: 0,
      totalSteps: 0,
    });

    await expect(new WeeklyReportService(dataSource.manager).submit(report.id, 1))
      .rejects.toThrow('请填写周报内容后再提交');
  });

  it('列表与按周查询均严格限定用户并使用数据库分页', async () => {
    const dataSource = getTestDataSource();
    const repo = dataSource.getRepository(WeeklyReport);
    await repo.save([
      {
        userId: 1, weekStart: '2026-07-06', weekEnd: '2026-07-12', content: '第一周',
        summary: '', totalDays: 0, status: 'draft', currentStep: 0, totalSteps: 0,
      },
      {
        userId: 1, weekStart: '2026-07-13', weekEnd: '2026-07-19', content: '第二周',
        summary: '', totalDays: 0, status: 'draft', currentStep: 0, totalSteps: 0,
      },
    ]);
    const service = new WeeklyReportService(dataSource.manager);
    const page = await service.getByUser(1, { page: 2, pageSize: 1 });
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page.list[0].weekStart).toBe('2026-07-06');
    await expect(service.getByWeek(1, '2026-07-13')).resolves.toMatchObject({ content: '第二周' });
    await expect(service.getByWeek(2, '2026-07-13')).resolves.toBeNull();
  });

  it('有效周报提交后创建审批实例和待办任务', async () => {
    const dataSource = getTestDataSource();
    await new ApprovalFlowEngine(dataSource.manager).createFlow({
      name: '周报默认审批',
      type: 'weekly_report',
      isDefault: true,
      steps: [{ stepType: 'custom', label: '负责人审批', customApproverId: 2 }],
    });
    const report = await new WeeklyReportService(dataSource.manager).createOrUpdate({
      userId: 1,
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      content: '本周完成审批状态机审查',
    });

    await new WeeklyReportService(dataSource.manager).submit(report.id, 1);
    const submitted = await dataSource.getRepository(WeeklyReport).findOneByOrFail({ id: report.id });
    expect(submitted).toMatchObject({ status: 'submitted', currentStep: 1, totalSteps: 1 });
    expect(submitted.approvalInstanceId).toBeTruthy();
    expect(await dataSource.getRepository(ApprovalInstance).countBy({
      targetType: 'weekly_report', targetId: report.id,
    })).toBe(1);
    await expect(dataSource.getRepository(ApprovalTask).findOneByOrFail({
      instanceId: submitted.approvalInstanceId!, approverId: 2,
    })).resolves.toMatchObject({ status: 'pending', stepOrder: 1 });
  });

  it('提交严格校验记录存在、所有权和草稿状态', async () => {
    const dataSource = getTestDataSource();
    const repo = dataSource.getRepository(WeeklyReport);
    const report = await repo.save({
      userId: 1, weekStart: '2026-07-20', weekEnd: '2026-07-26', content: '有效内容',
      summary: '', totalDays: 1, status: 'approved', currentStep: 0, totalSteps: 0,
    });
    const service = new WeeklyReportService(dataSource.manager);
    await expect(service.submit(999, 1)).rejects.toThrow('周报不存在');
    await expect(service.submit(report.id, 2)).rejects.toThrow('只能提交自己的周报');
    await expect(service.submit(report.id, 1)).rejects.toThrow('仅草稿状态可提交');
  });
});
