import { describe, expect, it, vi } from 'vitest';
import { Notification } from '@server/entities/Notification';
import { NotificationService } from '@server/services/notificationService';

function serviceWithRepo(repo: Record<string, unknown>) {
  const manager = {
    getRepository(entity: unknown) {
      if (entity !== Notification) throw new Error('测试访问了未配置的仓库');
      return repo;
    },
  };
  return new NotificationService(manager as any);
}

describe('NotificationService', () => {
  it('创建单条和批量通知时只写入指定收件人', async () => {
    const create = vi.fn((value) => value);
    const save = vi.fn(async (value) => value);
    const service = serviceWithRepo({ create, save });

    await expect(service.create({ userId: 7, type: 'approval', title: '待审批' }))
      .resolves.toMatchObject({ userId: 7, title: '待审批' });
    await expect(service.createBatch([7, 8], { type: 'announcement', title: '公告' }))
      .resolves.toEqual([
        { userId: 7, type: 'announcement', title: '公告' },
        { userId: 8, type: 'announcement', title: '公告' },
      ]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('空收件人批次不访问数据库', async () => {
    const create = vi.fn();
    const save = vi.fn();
    await expect(serviceWithRepo({ create, save }).createBatch([], { type: 'notice', title: '空' }))
      .resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('通知列表按当前用户、已读状态和分页查询', async () => {
    const qb: any = {
      where: vi.fn(() => qb),
      andWhere: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      getCount: vi.fn().mockResolvedValue(3),
      skip: vi.fn(() => qb),
      take: vi.fn(() => qb),
      getMany: vi.fn().mockResolvedValue([{ id: 2 }]),
    };
    const result = await serviceWithRepo({ createQueryBuilder: vi.fn(() => qb) })
      .getByUser(7, { isRead: false, page: 2, pageSize: 5 });
    expect(result).toEqual({ list: [{ id: 2 }], total: 3, page: 2, pageSize: 5 });
    expect(qb.where).toHaveBeenCalledWith('n.userId = :userId', { userId: 7 });
    expect(qb.andWhere).toHaveBeenCalledWith('n.isRead = :isRead', { isRead: false });
    expect(qb.skip).toHaveBeenCalledWith(5);
    expect(qb.take).toHaveBeenCalledWith(5);
  });

  it('未读计数和全部已读均限定当前用户', async () => {
    const count = vi.fn().mockResolvedValue(4);
    const update = vi.fn().mockResolvedValue({ affected: 4 });
    const service = serviceWithRepo({ count, update });
    await expect(service.getUnreadCount(7)).resolves.toBe(4);
    expect(count).toHaveBeenCalledWith({ where: { userId: 7, isRead: false } });
    await service.markAllAsRead(7);
    expect(update).toHaveBeenCalledWith({ userId: 7, isRead: false }, { isRead: true });
  });

  it('仅更新当前用户拥有的通知', async () => {
    const update = vi.fn().mockResolvedValue({ affected: 2 });
    const service = serviceWithRepo({ update });

    await service.markAsRead(7, [1, 2]);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7 }),
      { isRead: true },
    );
  });

  it('空 ID 列表不访问数据库', async () => {
    const update = vi.fn();
    await serviceWithRepo({ update }).markAsRead(7, []);
    expect(update).not.toHaveBeenCalled();
  });

  it('删除时使用用户 ID 与通知 ID 组合条件，避免越权和存在性泄露', async () => {
    const remove = vi.fn().mockResolvedValue({ affected: 1 });
    await serviceWithRepo({ delete: remove }).delete(7, 15);
    expect(remove).toHaveBeenCalledWith({ id: 15, userId: 7 });
  });

  it('删除不存在或属于他人的通知统一返回不存在', async () => {
    const remove = vi.fn().mockResolvedValue({ affected: 0 });
    await expect(serviceWithRepo({ delete: remove }).delete(7, 15))
      .rejects.toMatchObject({ message: '通知不存在', statusCode: 404 });
  });
});
