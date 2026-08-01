import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';
import { Timesheet } from '@server/entities/Timesheet';
import { User } from '@server/entities/User';
import { Project } from '@server/entities/Project';

// mock 队列入队：恢复扫描器只负责重新入队，实际消费由 worker 处理
vi.mock('@server/services/approvalQueue', () => ({
  enqueueTimesheetApprovals: vi.fn().mockResolvedValue(true),
}));

import { ApprovalRecoveryService } from '@server/services/approvalRecoveryService';
import { enqueueTimesheetApprovals } from '@server/services/approvalQueue';

describe('ApprovalRecoveryService 孤儿 submitted 恢复', () => {
  beforeEach(async () => {
    const dataSource = await setupTestDb();
    await dataSource.getRepository(User).save([
      { id: 1, username: 'recovery-user', password: 'hash', realName: '恢复用户', status: 1, roles: [] },
    ]);
    await dataSource.getRepository(Project).save([
      { id: 1, name: '项目一', code: 'REC-1', status: 'active', managers: [] },
      { id: 2, name: '项目二', code: 'REC-2', status: 'active', managers: [] },
      { id: 3, name: '项目三', code: 'REC-3', status: 'active', managers: [] },
    ]);
    vi.clearAllMocks();
  });
  afterEach(teardownTestDb);

  it('把提交超过阈值且无审批实例的记录按 submissionGroupId 重新入队', async () => {
    const dataSource = getTestDataSource();
    const repo = dataSource.getRepository(Timesheet);
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const recent = new Date();
    const groupRows = await repo.save([
      {
        userId: 1, projectId: 1, date: '2026-07-20', days: 0.5, description: 'a',
        status: 'submitted', submissionGroupId: 101, rootGroupId: 101,
      },
      {
        userId: 1, projectId: 1, date: '2026-07-21', days: 0.5, description: 'b',
        status: 'submitted', submissionGroupId: 101, rootGroupId: 101,
      },
      {
        userId: 1, projectId: 2, date: '2026-07-22', days: 1, description: 'c',
        status: 'submitted', submissionGroupId: 102, rootGroupId: 102,
      },
      {
        userId: 1, projectId: 3, date: '2026-07-23', days: 1, description: 'd',
        status: 'submitted', submissionGroupId: null, rootGroupId: null,
      },
    ]);
    // @UpdateDateColumn 会覆盖 save 传入的 updatedAt：用原生 SQL 把前 3 行改为 10 分钟前（孤儿）
    await dataSource.query(
      `UPDATE "timesheets" SET "updatedAt" = $1 WHERE "id" IN ($2, $3, $4)`,
      [stale, groupRows[0].id, groupRows[1].id, groupRows[2].id],
    );

    const count = await new ApprovalRecoveryService().reconcile(dataSource);
    expect(count).toBe(2); // 组 101 与组 102（组 101 两行合成一个任务；recent 记录不满足阈值）
    expect(enqueueTimesheetApprovals).toHaveBeenCalledTimes(1);
    const jobs = vi.mocked(enqueueTimesheetApprovals).mock.calls[0][0];
    expect(jobs).toHaveLength(2);
    const group101Job = jobs.find((j) => j.recordIds.includes(groupRows[0].id));
    expect(group101Job?.recordIds).toHaveLength(2);
    expect(group101Job?.targetId).toBe(groupRows[1].id); // 组内最新记录作为 head
    expect(group101Job?.projectId).toBe(1);
    expect(group101Job?.userId).toBe(1);
    // recent 记录（未超阈值）与已 deprecated 记录不入队
    expect(jobs.some((j) => j.recordIds.includes(groupRows[3].id))).toBe(false);
  });

  it('没有孤儿记录时不入队', async () => {
    const dataSource = getTestDataSource();
    const repo = dataSource.getRepository(Timesheet);
    await repo.save({
      userId: 1, projectId: 1, date: '2026-07-20', days: 0.5, description: 'ok',
      status: 'submitted', submissionGroupId: 201, rootGroupId: 201,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const count = await new ApprovalRecoveryService().reconcile(dataSource);
    expect(count).toBe(0);
    expect(enqueueTimesheetApprovals).not.toHaveBeenCalled();
  });
});
