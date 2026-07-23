import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  destroy: vi.fn(),
  initRedis: vi.fn(),
  closeRedis: vi.fn(),
  startQueue: vi.fn(),
  stopQueue: vi.fn(),
  batchSize: vi.fn(),
}));

vi.mock('@server/config/database', () => ({
  AppDataSource: {
    initialize: mocks.initialize,
    destroy: mocks.destroy,
    isInitialized: true,
  },
}));
vi.mock('@server/config/redis', () => ({ initRedis: mocks.initRedis, closeRedis: mocks.closeRedis }));
vi.mock('@server/services/approvalQueue', () => ({
  startApprovalQueueWorker: mocks.startQueue,
  stopApprovalQueueWorker: mocks.stopQueue,
  approvalBatchSize: mocks.batchSize,
}));

const {
  registerApprovalWorkerSignals,
  startApprovalWorker,
  stopApprovalWorker,
} = await import('@server/approvalWorker');

describe('独立审批 Worker 生命周期', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.initialize.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
    mocks.initRedis.mockResolvedValue(true);
    mocks.closeRedis.mockResolvedValue(undefined);
    mocks.startQueue.mockResolvedValue(undefined);
    mocks.stopQueue.mockResolvedValue(undefined);
    mocks.batchSize.mockReturnValue(20);
  });

  it('数据库和 Redis 就绪后启动批量消费', async () => {
    await startApprovalWorker();
    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.startQueue).toHaveBeenCalledOnce();
    expect(mocks.startQueue.mock.calls[0][0]).toEqual(expect.any(Function));
  });

  it('Redis 不可用时销毁已建立的数据库连接并拒绝启动', async () => {
    mocks.initRedis.mockResolvedValue(false);
    await expect(startApprovalWorker()).rejects.toThrow('Redis 不可用');
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.startQueue).not.toHaveBeenCalled();
  });

  it('停止时依次释放队列、Redis 和数据库，且不强制退出测试进程', async () => {
    await stopApprovalWorker(false);
    expect(mocks.stopQueue).toHaveBeenCalledOnce();
    expect(mocks.closeRedis).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('显式注册两个退出信号', () => {
    const once = vi.fn();
    registerApprovalWorkerSignals({ once } as any);
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});
