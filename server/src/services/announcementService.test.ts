import { describe, expect, it, vi } from 'vitest';
import { Announcement } from '../entities/Announcement';
import { AnnouncementRead } from '../entities/AnnouncementRead';
import { Group } from '../entities/Group';
import { AnnouncementService } from './announcementService';

describe('AnnouncementService', () => {
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
});
