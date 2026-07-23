import { afterEach, describe, expect, it, vi } from 'vitest';
import { Announcement } from '@server/entities/Announcement';
import { AnnouncementRead } from '@server/entities/AnnouncementRead';
import { Group } from '@server/entities/Group';
import { AnnouncementService } from '@server/services/announcementService';
import { UserAudienceService } from '@server/services/notifications/userAudienceService';

afterEach(() => vi.restoreAllMocks());

describe('AnnouncementService', () => {
  it('发布公告前严格校验目标范围，不会静默发布给空的错误对象', async () => {
    const save = vi.fn();
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { create: vi.fn((value) => value), save };
        if (entity === AnnouncementRead || entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    const resolve = vi.spyOn(UserAudienceService.prototype, 'resolveUserIds')
      .mockRejectedValue(new Error('目标用户无效'));
    const payload = {
      title: '错误范围公告',
      targetScope: 'user' as const,
      targetUserIds: [999],
      createdById: 1,
    };

    await expect(new AnnouncementService(manager as any).create(payload)).rejects.toThrow('目标用户无效');
    expect(resolve).toHaveBeenCalledWith(payload, { strict: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('管理端公告列表只返回发布人展示名，不泄露用户实体字段', async () => {
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return {
          findAndCount: vi.fn().mockResolvedValue([[
            {
              id: 1,
              title: '安全公告',
              createdBy: { id: 8, realName: '管理员', password: 'password-hash', tokenVersion: 4 },
            },
          ], 1]),
        };
        if (entity === AnnouncementRead || entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };

    const result = await new AnnouncementService(manager as any).getList({ page: 1, pageSize: 20 });

    expect(result.list[0]).toMatchObject({ id: 1, createdByName: '管理员' });
    expect(result.list[0].createdBy).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('password-hash');
  });

  it('批量已读应写入每条可见公告的 ID', async () => {
    const save = vi.fn();
    const announcementRepo = {
      createQueryBuilder: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([{ id: 11 }, { id: 12 }]),
      })),
    };
    const readRepo = {
      find: vi.fn().mockResolvedValue([]),
      create: vi.fn((value) => value),
      save,
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return announcementRepo;
        if (entity === AnnouncementRead) return readRepo;
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };

    await new AnnouncementService(manager as any).markAllAsRead(7, null, null);

    expect(save).toHaveBeenCalledWith([
      { userId: 7, announcementId: 11 },
      { userId: 7, announcementId: 12 },
    ]);
  });

  it('未读统计应将全部可见范围作为整体再追加未读条件', async () => {
    const where = vi.fn().mockReturnThis();
    const andWhere = vi.fn().mockReturnThis();
    const announcementRepo = {
      createQueryBuilder: vi.fn(() => ({
        leftJoin: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        where,
        andWhere,
        getRawMany: vi.fn().mockResolvedValue([]),
      })),
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return announcementRepo;
        if (entity === AnnouncementRead) return {};
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };

    await new AnnouncementService(manager as any).getUnreadCount(7, 3, null);

    const visibleWhere = where.mock.calls[0][0] as string;
    expect(visibleWhere.startsWith('(')).toBe(true);
    expect(visibleWhere.endsWith(')')).toBe(true);
    expect(visibleWhere).toContain(' OR ');
    expect(andWhere).toHaveBeenCalledWith('r.id IS NULL');
  });

  it('单条已读只允许写入当前用户可见的公告', async () => {
    const save = vi.fn();
    const queryBuilder = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getOne: vi.fn().mockResolvedValue({ id: 21 }),
    };
    const announcementRepo = { createQueryBuilder: vi.fn(() => queryBuilder) };
    const readRepo = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((value) => value),
      save,
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return announcementRepo;
        if (entity === AnnouncementRead) return readRepo;
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };

    await new AnnouncementService(manager as any).markAsRead(7, 21, 3, null);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('a.id = :announcementId', { announcementId: 21 });
    expect(save).toHaveBeenCalledWith({ userId: 7, announcementId: 21 });
  });

  it('不可见公告不能被标记已读', async () => {
    const queryBuilder = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getOne: vi.fn().mockResolvedValue(null),
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { createQueryBuilder: () => queryBuilder };
        if (entity === AnnouncementRead) return {};
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };

    await expect(new AnnouncementService(manager as any).markAsRead(7, 99, null, null))
      .rejects.toThrow('公告不存在或不可见');
  });

  it('删除公告时先校验存在，再清理已读记录和公告', async () => {
    const readDelete = vi.fn();
    const announcementDelete = vi.fn();
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return {
          findOne: vi.fn().mockResolvedValue({ id: 8 }),
          delete: announcementDelete,
        };
        if (entity === AnnouncementRead) return { delete: readDelete };
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };

    await new AnnouncementService(manager as any).delete(8);

    expect(readDelete).toHaveBeenCalledWith({ announcementId: 8 });
    expect(announcementDelete).toHaveBeenCalledWith(8);
  });

  it('已读统计只计算公告当前范围内的用户', async () => {
    const findReads = vi.fn().mockResolvedValue([
      { userId: 2, user: { realName: '当前用户' }, readAt: new Date('2026-07-22T00:00:00Z') },
    ]);
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { findOne: vi.fn().mockResolvedValue({ id: 9, targetScope: 'user' }) };
        if (entity === AnnouncementRead) return { find: findReads };
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    vi.spyOn(UserAudienceService.prototype, 'resolveUserIds').mockResolvedValue([2]);

    const result = await new AnnouncementService(manager as any).getReadStats(9);

    expect(result).toMatchObject({ targetCount: 1, readCount: 1, unreadCount: 0, readRate: 100 });
    expect(result.readUsers).toEqual([expect.objectContaining({ userId: 2, realName: '当前用户' })]);
    const where = findReads.mock.calls[0][0].where;
    expect(where.announcementId).toBe(9);
    expect(where.userId._value).toEqual([2]);
  });

  it('更新公告先校验存在和新范围，并清除旧范围残留字段', async () => {
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const findOne = vi.fn()
      .mockResolvedValueOnce({ id: 3, targetScope: 'department', targetDeptId: 2 })
      .mockResolvedValueOnce({ id: 3, targetScope: 'group', targetGroupId: 4 });
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { findOne, update };
        if (entity === AnnouncementRead || entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    const resolve = vi.spyOn(UserAudienceService.prototype, 'resolveUserIds').mockResolvedValue([7]);
    const result = await new AnnouncementService(manager as any).update(3, {
      title: '新范围', targetScope: 'group', targetGroupId: 4,
    } as any);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ targetScope: 'group', targetGroupId: 4 }), { strict: true });
    expect(update).toHaveBeenCalledWith(3, expect.objectContaining({
      targetDeptId: null, targetGroupId: 4, targetUserIds: null,
    }));
    expect(result).toMatchObject({ id: 3, targetScope: 'group' });
  });

  it('更新或删除不存在的公告返回明确错误', async () => {
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { findOne: vi.fn().mockResolvedValue(null) };
        if (entity === AnnouncementRead || entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    const service = new AnnouncementService(manager as any);
    await expect(service.update(99, { title: '不存在' } as any)).rejects.toThrow('公告不存在');
    await expect(service.delete(99)).rejects.toMatchObject({ message: '公告不存在', statusCode: 404 });
  });

  it('用户公告列表展开上级组、按已读过滤并保持分页结果顺序', async () => {
    const visibleQb: any = {
      select: vi.fn(() => visibleQb),
      where: vi.fn(() => visibleQb),
      orderBy: vi.fn(() => visibleQb),
      getMany: vi.fn().mockResolvedValue([{ id: 13 }, { id: 12 }, { id: 11 }]),
    };
    const announcementRepo = {
      createQueryBuilder: vi.fn(() => visibleQb),
      find: vi.fn().mockResolvedValue([
        { id: 13, title: '最新', createdBy: { realName: '管理员', password: 'secret' } },
        { id: 11, title: '较早', createdBy: { realName: '管理员', password: 'secret' } },
      ]),
    };
    const readRepo = { find: vi.fn().mockResolvedValue([{ announcementId: 12 }]) };
    const groupRepo = { findOne: vi.fn().mockResolvedValue({ id: 8, path: '2/5/8' }) };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return announcementRepo;
        if (entity === AnnouncementRead) return readRepo;
        if (entity === Group) return groupRepo;
        throw new Error('测试访问了未配置的仓库');
      },
    };
    const result = await new AnnouncementService(manager as any)
      .getForUser(7, 3, 8, { page: 1, pageSize: 2, isRead: false });
    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 2 });
    expect(result.list.map((item: any) => item.id)).toEqual([13, 11]);
    expect(result.list.every((item: any) => item.isRead === false)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
    const whereParams = visibleQb.where.mock.calls[0][1];
    expect(whereParams.userGroupIds).toEqual([2, 5, 8]);
  });

  it('无可见公告或分页越界时不执行多余详情查询', async () => {
    const find = vi.fn();
    const readFind = vi.fn();
    const qb: any = {
      select: vi.fn(() => qb), where: vi.fn(() => qb), orderBy: vi.fn(() => qb),
      getMany: vi.fn().mockResolvedValue([]),
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { createQueryBuilder: () => qb, find };
        if (entity === AnnouncementRead) return { find: readFind };
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    await expect(new AnnouncementService(manager as any).getForUser(7, null, null, { page: 1, pageSize: 20 }))
      .resolves.toEqual({ list: [], total: 0, page: 1, pageSize: 20 });
    expect(readFind).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it('重复标记已读不会再次写入，全部已读在没有新增项时不保存', async () => {
    const singleQb: any = {
      select: vi.fn(() => singleQb), where: vi.fn(() => singleQb), andWhere: vi.fn(() => singleQb),
      getOne: vi.fn().mockResolvedValue({ id: 21 }),
    };
    const allQb: any = {
      select: vi.fn(() => allQb), where: vi.fn(() => allQb),
      getMany: vi.fn().mockResolvedValue([{ id: 21 }]),
    };
    const save = vi.fn();
    const announcementRepo = { createQueryBuilder: vi.fn().mockReturnValueOnce(singleQb).mockReturnValueOnce(allQb) };
    const readRepo = {
      findOne: vi.fn().mockResolvedValue({ id: 1, userId: 7, announcementId: 21 }),
      find: vi.fn().mockResolvedValue([{ announcementId: 21 }]),
      save,
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return announcementRepo;
        if (entity === AnnouncementRead) return readRepo;
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    const service = new AnnouncementService(manager as any);
    await service.markAsRead(7, 21, null, null);
    await service.markAllAsRead(7, null, null);
    expect(save).not.toHaveBeenCalled();
  });

  it('空公告范围统计返回零且不查询已读用户', async () => {
    const find = vi.fn();
    const manager = {
      getRepository(entity: unknown) {
        if (entity === Announcement) return { findOne: vi.fn().mockResolvedValue({ id: 9, targetScope: 'user' }) };
        if (entity === AnnouncementRead) return { find };
        if (entity === Group) return {};
        throw new Error('测试访问了未配置的仓库');
      },
    };
    vi.spyOn(UserAudienceService.prototype, 'resolveUserIds').mockResolvedValue([]);
    await expect(new AnnouncementService(manager as any).getReadStats(9)).resolves.toMatchObject({
      targetCount: 0, readCount: 0, unreadCount: 0, readRate: 0, readUsers: [],
    });
    expect(find).not.toHaveBeenCalled();
  });
});
