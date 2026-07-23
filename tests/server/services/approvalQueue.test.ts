import { describe, expect, it, vi } from 'vitest';
import {
  isolateApprovalJobFailures,
  type ParsedApprovalQueueEntry,
  type TimesheetApprovalJob,
} from '@server/services/approvalQueue';

function item(id: string, targetId: number): ParsedApprovalQueueEntry {
  const job: TimesheetApprovalJob = {
    targetId,
    recordIds: [targetId],
    projectId: 1,
    userId: 1,
    title: `审批 ${targetId}`,
  };
  return { id, job, entry: { id, message: { payload: JSON.stringify(job) } } };
}

describe('审批队列坏任务隔离', () => {
  it('批次成功时只调用一次批处理', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const entries = [item('1-0', 1), item('2-0', 2)];

    const result = await isolateApprovalJobFailures(entries, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(entries.map((entry) => entry.job));
    expect(result.succeeded.map((entry) => entry.id)).toEqual(['1-0', '2-0']);
    expect(result.failed).toEqual([]);
  });

  it('整批失败后逐条隔离，坏任务不会阻止正常任务确认成功', async () => {
    const handler = vi.fn(async (jobs: TimesheetApprovalJob[]) => {
      if (jobs.length > 1 || jobs[0].targetId === 2) throw new Error('目标记录损坏');
    });
    const entries = [item('1-0', 1), item('2-0', 2), item('3-0', 3)];

    const result = await isolateApprovalJobFailures(entries, handler);
    expect(handler).toHaveBeenCalledTimes(4);
    expect(result.succeeded.map((entry) => entry.id)).toEqual(['1-0', '3-0']);
    expect(result.failed.map((entry) => entry.id)).toEqual(['2-0']);
    expect(String(result.failed[0].error)).toContain('目标记录损坏');
  });
});
