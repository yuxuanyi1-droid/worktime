import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDataSource } from '@server/config/database';
import { AuditService } from '@server/services/auditService';
import { logger } from '@server/utils/logger';

afterEach(() => vi.restoreAllMocks());

function queryBuilder(list: any[] = [], total = list.length) {
  return {
    leftJoinAndSelect: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    getCount: vi.fn().mockResolvedValue(total),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getMany: vi.fn().mockResolvedValue(list),
  };
}

describe('AuditService', () => {
  it('审计写入成功时创建并保存日志', async () => {
    const repo = {
      create: vi.fn((value) => ({ id: 1, ...value })),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue(repo as any);
    const data = { userId: 2, action: 'user.disable', target: 'user', targetId: 9, ip: '127.0.0.1' };

    await new AuditService().log(data);

    expect(repo.create).toHaveBeenCalledWith(data);
    expect(repo.save).toHaveBeenCalledWith({ id: 1, ...data });
  });

  it('审计写入失败不影响主业务，但必须留下错误日志', async () => {
    const failure = new Error('database unavailable');
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({
      create: vi.fn((value) => value),
      save: vi.fn().mockRejectedValue(failure),
    } as any);
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);

    await expect(new AuditService().log({ action: 'test', target: 'system' })).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: failure }), '审计日志写入失败');
  });

  it('组合过滤、分页并将缺失操作者显示为未知', async () => {
    const qb = queryBuilder([{
      id: 3,
      userId: null,
      user: null,
      action: 'system.start',
      target: 'system',
      targetId: null,
      detail: 'detail',
      ip: '127.0.0.1',
      createdAt: new Date('2026-07-22T00:00:00Z'),
    }], 31);
    vi.spyOn(AppDataSource, 'getRepository').mockReturnValue({ createQueryBuilder: vi.fn(() => qb) } as any);

    const result = await new AuditService().getLogs({
      userId: 7,
      action: 'system.start',
      target: 'system',
      startDate: '2026-07-01T00:00:00.000Z',
      endDate: '2026-07-31T23:59:59.999Z',
      page: 2,
      pageSize: 20,
    });

    expect(qb.andWhere).toHaveBeenCalledTimes(5);
    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(result).toMatchObject({ total: 31, page: 2, pageSize: 20 });
    expect(result.list[0]).toMatchObject({ id: 3, userName: '未知', action: 'system.start' });
  });
});
