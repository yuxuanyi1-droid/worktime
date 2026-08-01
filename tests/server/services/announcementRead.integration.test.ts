import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';
import { User } from '@server/entities/User';
import { Announcement } from '@server/entities/Announcement';
import { AnnouncementRead } from '@server/entities/AnnouncementRead';
import { AnnouncementService } from '@server/services/announcementService';

/**
 * markAllAsRead / markAsRead 真实集成测试。
 * 回归背景：markAllAsRead 曾用 getRawMany 取 .id——Postgres 下 raw 列名带表别名前缀
 * （a_id），取到 undefined 后批量插入 announcementId=NULL 违反 NOT NULL 约束；
 * 旧 mock 测试 mock 了查询链返回 [{ id }]，掩盖了该问题。
 */
describe('AnnouncementService 已读标记集成', () => {
  beforeEach(async () => {
    const ds = await setupTestDb();
    await ds.getRepository(User).save([
      { id: 1, username: 'ann-reader', password: 'hash', realName: '公告读者', status: 1, roles: [] },
      { id: 2, username: 'ann-author', password: 'hash', realName: '公告作者', status: 1, roles: [] },
    ]);
    await ds.getRepository(Announcement).save([
      {
        id: 1, title: '全员公告一', content: '内容一', type: 'info',
        targetScope: 'all', createdById: 2,
      },
      {
        id: 2, title: '全员公告二', content: '内容二', type: 'important',
        targetScope: 'all', createdById: 2,
      },
    ]);
  });
  afterEach(teardownTestDb);

  it('全部已读：为所有可见公告写入 announcement_reads（announcementId 非空）', async () => {
    const ds = getTestDataSource();
    const service = new AnnouncementService(ds.manager);
    await service.markAllAsRead(1, null, null);

    const reads = await ds.getRepository(AnnouncementRead).find({ where: { userId: 1 }, order: { announcementId: 'ASC' } });
    expect(reads).toHaveLength(2);
    expect(reads.map((r) => r.announcementId).sort()).toEqual([1, 2]);
    expect(reads.every((r) => r.announcementId !== null && r.announcementId !== undefined)).toBe(true);
  });

  it('全部已读幂等：重复调用不冲突、不产生重复行（orIgnore + 唯一约束）', async () => {
    const ds = getTestDataSource();
    const service = new AnnouncementService(ds.manager);
    await service.markAllAsRead(1, null, null);
    await service.markAllAsRead(1, null, null);

    const count = await ds.getRepository(AnnouncementRead).count({ where: { userId: 1 } });
    expect(count).toBe(2);
  });

  it('单条已读与未读计数一致', async () => {
    const ds = getTestDataSource();
    const service = new AnnouncementService(ds.manager);
    await service.markAsRead(1, 1, null, null);
    const reads = await ds.getRepository(AnnouncementRead).find({ where: { userId: 1 } });
    expect(reads).toHaveLength(1);
    expect(reads[0].announcementId).toBe(1);
    expect(reads[0].userId).toBe(1);
  });
});
