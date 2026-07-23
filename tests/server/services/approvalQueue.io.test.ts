import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRedis: vi.fn(),
  isRedisReady: vi.fn(),
  xAdd: vi.fn(),
  xLen: vi.fn(),
}));

vi.mock('@server/config/redis', () => ({
  getRedis: mocks.getRedis,
  isRedisReady: mocks.isRedisReady,
}));

const {
  approvalBatchSize,
  approvalDeadLetterLength,
  approvalQueueLength,
  enqueueTimesheetApprovals,
  parseApprovalQueueEntries,
  startApprovalQueueWorker,
} = await import('@server/services/approvalQueue');

describe('审批队列 Redis I/O 边界', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getRedis.mockReturnValue({ isReady: true, xAdd: mocks.xAdd, xLen: mocks.xLen });
    mocks.isRedisReady.mockReturnValue(true);
    mocks.xAdd.mockResolvedValue('1-0');
    mocks.xLen.mockResolvedValue(3);
    delete process.env.APPROVAL_BATCH_SIZE;
    delete process.env.REDIS_URL;
  });

  it('Redis 未就绪或空任务时不入队', async () => {
    mocks.getRedis.mockReturnValueOnce(null);
    await expect(enqueueTimesheetApprovals([{
      targetId: 1, recordIds: [1], projectId: 1, userId: 1, title: '审批',
    }])).resolves.toBe(false);
    await expect(enqueueTimesheetApprovals([])).resolves.toBe(false);
    expect(mocks.xAdd).not.toHaveBeenCalled();
  });

  it('将每个任务作为独立 Stream 消息入队并设置近似长度上限', async () => {
    const jobs = [
      { targetId: 1, recordIds: [1], projectId: 2, userId: 3, title: '任务1' },
      { targetId: 2, recordIds: [2, 3], projectId: 2, userId: 3, title: '任务2' },
    ];
    await expect(enqueueTimesheetApprovals(jobs)).resolves.toBe(true);
    expect(mocks.xAdd).toHaveBeenCalledTimes(2);
    expect(mocks.xAdd).toHaveBeenNthCalledWith(1,
      'worktime:stream:timesheet-approval', '*', { payload: JSON.stringify(jobs[0]) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100_000 } },
    );
  });

  it('Redis 异常时入队失败和长度查询均安全降级', async () => {
    mocks.xAdd.mockRejectedValue(new Error('redis down'));
    await expect(enqueueTimesheetApprovals([{
      targetId: 1, recordIds: [1], projectId: 1, userId: 1, title: '审批',
    }])).resolves.toBe(false);
    mocks.xLen.mockRejectedValue(new Error('redis down'));
    await expect(approvalQueueLength()).resolves.toBe(0);
    await expect(approvalDeadLetterLength()).resolves.toBe(0);
  });

  it('分别查询主队列和死信队列长度', async () => {
    mocks.xLen.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    await expect(approvalQueueLength()).resolves.toBe(4);
    await expect(approvalDeadLetterLength()).resolves.toBe(2);
    expect(mocks.xLen).toHaveBeenNthCalledWith(1, 'worktime:stream:timesheet-approval');
    expect(mocks.xLen).toHaveBeenNthCalledWith(2, 'worktime:stream:timesheet-approval:dead');
  });

  it('严格校验任务 JSON 与所有关键 ID，坏消息单独进入 invalid 集合', () => {
    const valid = {
      targetId: 1, recordIds: [2, 3], projectId: 4, userId: 5, title: '有效任务',
    };
    const entries = [
      { id: '1-0', message: { payload: JSON.stringify(valid) } },
      { id: '2-0', message: {} },
      { id: '3-0', message: { payload: '{bad json' } },
      { id: '4-0', message: { payload: JSON.stringify({ ...valid, userId: 0 }) } },
      { id: '5-0', message: { payload: JSON.stringify({ ...valid, recordIds: [2, -1] }) } },
    ];
    const parsed = parseApprovalQueueEntries(entries);
    expect(parsed.items.map(item => item.id)).toEqual(['1-0']);
    expect(parsed.invalidEntries.map(item => item.id)).toEqual(['2-0', '3-0', '4-0', '5-0']);
  });

  it('批量大小采用安全默认值并限制在 1 到 100', () => {
    expect(approvalBatchSize()).toBe(20);
    process.env.APPROVAL_BATCH_SIZE = '0';
    expect(approvalBatchSize()).toBe(20);
    process.env.APPROVAL_BATCH_SIZE = '500';
    expect(approvalBatchSize()).toBe(100);
    process.env.APPROVAL_BATCH_SIZE = '7';
    expect(approvalBatchSize()).toBe(7);
  });

  it('未配置 REDIS_URL 时不创建后台消费循环', async () => {
    const handler = vi.fn();
    await startApprovalQueueWorker(handler);
    expect(handler).not.toHaveBeenCalled();
  });
});
