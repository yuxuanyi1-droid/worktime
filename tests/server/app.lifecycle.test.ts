import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  destroy: vi.fn(),
  ensureSchema: vi.fn(),
  query: vi.fn(),
  initRedis: vi.fn(),
  closeRedis: vi.fn(),
  syncSequence: vi.fn(),
  activateRateLimiters: vi.fn(),
  startQueue: vi.fn(),
  stopQueue: vi.fn(),
  ensureModels: vi.fn(),
  preloadPi: vi.fn(),
  stopAgent: vi.fn(),
  reminderStart: vi.fn(),
  reminderStop: vi.fn(),
}));

vi.mock('@server/config/database', () => ({
  AppDataSource: {
    initialize: mocks.initialize,
    destroy: mocks.destroy,
    query: mocks.query,
    entityMetadatas: [{ name: 'User' }],
    isInitialized: true,
    getRepository: vi.fn(),
  },
  ensureSchema: mocks.ensureSchema,
  databaseType: 'postgres',
}));

vi.mock('@server/config/redis', () => ({
  initRedis: mocks.initRedis,
  closeRedis: mocks.closeRedis,
  syncSubmissionGroupIdFromDb: mocks.syncSequence,
}));

vi.mock('@server/middleware/security', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    globalLimiter: pass,
    loginLimiter: pass,
    oidcCallbackLimiter: pass,
    agentLimiter: pass,
    activateRateLimiters: mocks.activateRateLimiters,
  };
});

vi.mock('@server/services/approvalQueue', () => ({
  startApprovalQueueWorker: mocks.startQueue,
  stopApprovalQueueWorker: mocks.stopQueue,
}));

vi.mock('@server/config/ai', () => ({ ensurePiModelsJson: mocks.ensureModels }));
vi.mock('@server/ai/agentRunner', () => ({ preloadPi: mocks.preloadPi, stopAgentWorker: mocks.stopAgent }));
vi.mock('@server/services/timesheetReminderService', () => ({
  timesheetReminderScheduler: { start: mocks.reminderStart, stop: mocks.reminderStop },
  TIMESHEET_REMINDER_SETTING_KEY: 'timesheet_reminder_config',
  normalizeTimesheetReminderConfig: (value: unknown) => value,
}));

const { app, gracefulShutdown, registerShutdownSignals, startServer } = await import('@server/app');

function fakeServer() {
  return {
    closeIdleConnections: vi.fn(),
    close: vi.fn((callback: () => void) => callback()),
  } as any;
}

describe('API 入口生命周期', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.initialize.mockResolvedValue(undefined);
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.initRedis.mockResolvedValue(true);
    mocks.query.mockResolvedValue([{ maxId: 19 }]);
    mocks.syncSequence.mockResolvedValue(undefined);
    mocks.startQueue.mockResolvedValue(undefined);
    mocks.stopQueue.mockResolvedValue(undefined);
    mocks.stopAgent.mockResolvedValue(undefined);
    mocks.closeRedis.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await gracefulShutdown('TEST', false);
  });

  it('存储初始化成功后同步序号、启动后台能力并监听 HTTP', async () => {
    const server = fakeServer();
    vi.spyOn(app, 'listen').mockReturnValue(server);

    await expect(startServer()).resolves.toBe(server);

    expect(mocks.ensureSchema).toHaveBeenCalledOnce();
    expect(mocks.syncSequence).toHaveBeenCalledWith(19);
    expect(mocks.startQueue).toHaveBeenCalledOnce();
    expect(mocks.ensureModels).toHaveBeenCalledOnce();
    expect(mocks.preloadPi).toHaveBeenCalledOnce();
    expect(mocks.reminderStart).toHaveBeenCalledOnce();
    expect(mocks.activateRateLimiters).toHaveBeenCalledOnce();
  });

  it('数据库初始化失败时仍以未连接模式启动，且限流器照常激活', async () => {
    mocks.initialize.mockRejectedValue(new Error('database unavailable'));
    mocks.initRedis.mockResolvedValue(false);
    const server = fakeServer();
    vi.spyOn(app, 'listen').mockReturnValue(server);

    await expect(startServer()).resolves.toBe(server);

    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.activateRateLimiters).toHaveBeenCalledOnce();
    expect(mocks.reminderStart).not.toHaveBeenCalled();
  });

  it('优雅退出停止接入、Worker、Redis、数据库和提醒调度', async () => {
    const server = fakeServer();
    vi.spyOn(app, 'listen').mockReturnValue(server);
    await startServer();

    await gracefulShutdown('SIGTERM', false);

    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(mocks.reminderStop).toHaveBeenCalledOnce();
    expect(mocks.stopAgent).toHaveBeenCalledOnce();
    expect(mocks.stopQueue).toHaveBeenCalledOnce();
    expect(mocks.closeRedis).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('仅在显式调用时注册一次 SIGINT/SIGTERM 监听', () => {
    const once = vi.fn();
    registerShutdownSignals({ once } as any);
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});
