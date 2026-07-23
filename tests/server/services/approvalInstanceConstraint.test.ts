import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalInstance } from '@server/entities/ApprovalInstance';
import { User } from '@server/entities/User';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';

function instance(status: ApprovalInstance['status']) {
  return {
    targetType: 'weekly_report' as const,
    targetId: 100,
    applicantId: 1,
    status,
    currentStepOrder: status === 'pending' ? 1 : null,
    totalSteps: 1,
    flowId: null,
    flowVersionId: null,
    flowName: '测试流程',
    flowVersionNumber: 1,
    stepsSnapshot: [],
    quotaSnapshot: null,
    submittedAt: new Date(),
    finishedAt: status === 'pending' ? null : new Date(),
  };
}

describe('审批实例重提约束', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save({
      id: 1,
      username: 'applicant',
      password: 'test-password-hash',
      realName: '申请人',
    });
  });
  afterEach(teardownTestDb);

  it('允许同一业务记录保留多次已结束审批实例', async () => {
    const repo = getTestDataSource().getRepository(ApprovalInstance);
    await repo.save(repo.create(instance('rejected')));
    await repo.save(repo.create(instance('withdrawn')));

    expect(await repo.countBy({ targetType: 'weekly_report', targetId: 100 })).toBe(2);
  });

  it('拒绝同一业务记录同时创建两个进行中的审批实例', async () => {
    const repo = getTestDataSource().getRepository(ApprovalInstance);
    await repo.save(repo.create(instance('pending')));

    await expect(repo.save(repo.create(instance('pending')))).rejects.toThrow();
  });
});
