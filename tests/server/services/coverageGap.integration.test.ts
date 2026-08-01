import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDataSource, setupTestDb, teardownTestDb } from '../helpers/database';
import { User } from '@server/entities/User';
import { Department } from '@server/entities/Department';
import { Group } from '@server/entities/Group';
import { Notification } from '@server/entities/Notification';
import { Announcement } from '@server/entities/Announcement';
import { AnnouncementRead } from '@server/entities/AnnouncementRead';
import { NotificationService } from '@server/services/notificationService';
import { UserAudienceService } from '@server/services/notifications/userAudienceService';
import { AnnouncementService } from '@server/services/announcementService';

/**
 * 真实集成测试：补齐「被 mock 掩盖、真实实现从未在 DB 上验证」的高风险盲区
 * （NotificationService / UserAudienceService / AnnouncementService 可见性·统计）。
 * 背景：markAllAsRead 曾因 mock 掩盖 raw 键名问题而在真实环境崩溃，此处防同类盲区。
 */

describe('NotificationService 集成（真实 DB）', () => {
  beforeEach(async () => {
    const ds = await setupTestDb();
    await ds.getRepository(User).save([
      { id: 1, username: 'notif-a', password: 'hash', realName: '通知甲', status: 1, roles: [] },
      { id: 2, username: 'notif-b', password: 'hash', realName: '通知乙', status: 1, roles: [] },
    ]);
    const svc = new NotificationService(ds.manager);
    await svc.createBatch([1, 1, 2], { type: 'approval_pending', title: '待审批', content: '内容' });
    await svc.create({ userId: 1, type: 'system', title: '系统通知' });
  });
  afterEach(teardownTestDb);

  it('getByUser 只返回本人通知，isRead 过滤与分页正确', async () => {
    const ds = getTestDataSource();
    const svc = new NotificationService(ds.manager);
    const all = await svc.getByUser(1, { page: 1, pageSize: 20 });
    expect(all.total).toBe(3);
    expect(all.list.every((n) => n.userId === 1)).toBe(true);
    const unread = await svc.getByUser(1, { isRead: false, page: 1, pageSize: 20 });
    expect(unread.total).toBe(3);
    const paged = await svc.getByUser(1, { page: 1, pageSize: 2 });
    expect(paged.list).toHaveLength(2);
    expect(paged.total).toBe(3);
  });

  it('getUnreadCount / markAsRead / markAllAsRead 只影响目标用户', async () => {
    const ds = getTestDataSource();
    const svc = new NotificationService(ds.manager);
    expect(await svc.getUnreadCount(1)).toBe(3);
    expect(await svc.getUnreadCount(2)).toBe(1);
    const ids = (await svc.getByUser(1, { page: 1, pageSize: 20 })).list.map((n) => n.id);
    await svc.markAsRead(1, ids.slice(0, 2));
    expect(await svc.getUnreadCount(1)).toBe(1);
    expect(await svc.getUnreadCount(2)).toBe(1); // 用户 2 不受影响
    await svc.markAllAsRead(1);
    expect(await svc.getUnreadCount(1)).toBe(0);
    expect(await svc.getUnreadCount(2)).toBe(1);
  });

  it('delete 只允许删除本人通知，不存在时抛 404', async () => {
    const ds = getTestDataSource();
    const svc = new NotificationService(ds.manager);
    const [mine] = (await svc.getByUser(1, { page: 1, pageSize: 20 })).list;
    // 用户 2 删除用户 1 的通知：不匹配（复合条件 id+userId）→ 404，且不误删
    await expect(svc.delete(2, mine.id)).rejects.toThrow('通知不存在');
    expect(await svc.getByUser(1, { page: 1, pageSize: 20 })).toMatchObject({ total: 3 });
    expect(await svc.getByUser(2, { page: 1, pageSize: 20 })).toMatchObject({ total: 1 });
    // 本人删除成功
    await svc.delete(1, mine.id);
    expect(await svc.getByUser(1, { page: 1, pageSize: 20 })).toMatchObject({ total: 2 });
    // 用户 2 的通知不受影响
    expect(await svc.getByUser(2, { page: 1, pageSize: 20 })).toMatchObject({ total: 1 });
  });
});

describe('UserAudienceService.resolveUserIds 集成（真实 DB）', () => {
  beforeEach(async () => {
    const ds = await setupTestDb();
    const dept = await ds.getRepository(Department).save({ id: 1, name: '研发部', sortOrder: 1 });
    const g1 = await ds.getRepository(Group).save({ id: 1, name: '前端组', departmentId: dept.id, path: '1', sortOrder: 1 });
    const g2 = await ds.getRepository(Group).save({ id: 2, name: 'React小组', departmentId: dept.id, parentId: g1.id, path: '1/2', sortOrder: 1 });
    const g3 = await ds.getRepository(Group).save({ id: 3, name: '后端组', departmentId: dept.id, path: '3', sortOrder: 2 });
    await ds.getRepository(User).save([
      { id: 1, username: 'aud-a', password: 'hash', realName: '受众甲', status: 1, roles: [], department: dept, group: g1 },
      { id: 2, username: 'aud-b', password: 'hash', realName: '受众乙', status: 1, roles: [], department: dept, group: g2 },
      { id: 3, username: 'aud-c', password: 'hash', realName: '受众丙', status: 1, roles: [], department: dept, group: g3 },
      { id: 4, username: 'aud-disabled', password: 'hash', realName: '停用', status: 0, roles: [], department: dept, group: g1 },
    ]);
  });
  afterEach(teardownTestDb);

  it('all 范围只含启用用户', async () => {
    const ds = getTestDataSource();
    const svc = new UserAudienceService(ds.manager);
    expect(await svc.resolveUserIds({ targetScope: 'all' })).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(await svc.resolveUserIds({ targetScope: 'all' })).not.toContain(4);
  });

  it('group 范围包含所选分组及其全部子分组（path 前缀解析）', async () => {
    const ds = getTestDataSource();
    const svc = new UserAudienceService(ds.manager);
    const g1Ids = await svc.resolveUserIds({ targetScope: 'group', targetGroupId: 1 });
    expect(g1Ids.sort()).toEqual([1, 2]); // 前端组 + React小组
    const g2Ids = await svc.resolveUserIds({ targetScope: 'group', targetGroupId: 2 });
    expect(g2Ids).toEqual([2]);
    const g3Ids = await svc.resolveUserIds({ targetScope: 'group', targetGroupId: 3 });
    expect(g3Ids).toEqual([3]);
  });

  it('department 范围与 user 范围、strict 校验', async () => {
    const ds = getTestDataSource();
    const svc = new UserAudienceService(ds.manager);
    expect(await svc.resolveUserIds({ targetScope: 'department', targetDeptId: 1 })).toEqual(expect.arrayContaining([1, 2, 3]));
    await expect(svc.resolveUserIds({ targetScope: 'department', targetDeptId: 99 }, { strict: true })).rejects.toThrow('目标部门不存在');
    await expect(svc.resolveUserIds({ targetScope: 'user', targetUserIds: [1, 4] }, { strict: true })).rejects.toThrow('目标用户中包含不存在或已禁用的账号');
    expect((await svc.resolveUserIds({ targetScope: 'user', targetUserIds: [1, 4] })).sort()).toEqual([1]);
  });
});

describe('AnnouncementService 可见性与统计集成（真实 DB）', () => {
  beforeEach(async () => {
    const ds = await setupTestDb();
    const dept = await ds.getRepository(Department).save({ id: 1, name: '研发部', sortOrder: 1 });
    const g1 = await ds.getRepository(Group).save({ id: 1, name: '前端组', departmentId: dept.id, path: '1', sortOrder: 1 });
    const g2 = await ds.getRepository(Group).save({ id: 2, name: 'React小组', departmentId: dept.id, parentId: g1.id, path: '1/2', sortOrder: 1 });
    // 注意：显式 id 需落在自增序列内（pg-mem 对超出序列的显式 id 会重编），真实 Postgres 无此限制
    await ds.getRepository(User).save([
      { id: 1, username: 'ann-a', password: 'hash', realName: '公告甲', status: 1, roles: [], department: dept, group: g1 },
      { id: 2, username: 'ann-b', password: 'hash', realName: '公告乙', status: 1, roles: [], department: dept, group: g2 },
      { id: 3, username: 'ann-c', password: 'hash', realName: '公告丙', status: 1, roles: [], department: dept, group: g2 },
      { id: 4, username: 'ann-author', password: 'hash', realName: '公告作者', status: 1, roles: [] },
    ]);
    await ds.getRepository(Announcement).save([
      { id: 1, title: '全员公告', content: 'x', type: 'info', targetScope: 'all', createdById: 4 },
      { id: 2, title: '组内公告', content: 'x', type: 'info', targetScope: 'group', targetGroupId: 1, createdById: 4 },
      { id: 3, title: '部门公告', content: 'x', type: 'info', targetScope: 'department', targetDeptId: 1, createdById: 4 },
    ]);
  });
  afterEach(teardownTestDb);

  it('getForUser 按可见范围返回公告（all 全员 / group 含子组）', async () => {
    const ds = getTestDataSource();
    const svc = new AnnouncementService(ds.manager);
    // 用户 1（前端组）：all + group(1) + department(1)
    const list1 = await svc.getForUser(1, 1, 1, { page: 1, pageSize: 10 });
    expect(list1.total).toBe(3);
    // 用户 2（React小组，组 2）：all + group(2)（前端组子组，group=1 的公告对组2 可见？见下）
    const list2 = await svc.getForUser(2, 1, 2, { page: 1, pageSize: 10 });
    // 组 2 是组 1 的子组：targetGroupId=1 的公告应包含后代组成员
    expect(list2.list.map((a) => a.id).sort()).toEqual([1, 2, 3]);
  });

  it('getUnreadCount 只统计未读且可见的公告', async () => {
    const ds = getTestDataSource();
    const svc = new AnnouncementService(ds.manager);
    expect(await svc.getUnreadCount(2, 1, 2)).toBe(3);
    await svc.markAsRead(2, 1, 1, 2);
    expect(await svc.getUnreadCount(2, 1, 2)).toBe(2);
  });

  it('getReadStats 的受众/已读统计与 raw 查询正确（COUNT bigint 转换）', async () => {
    const ds = getTestDataSource();
    const svc = new AnnouncementService(ds.manager);
    const stats = await svc.getReadStats(1); // 全员公告，受众 = 4 个启用用户（作者 9 + 1/2/3）
    expect(stats.targetCount).toBe(4);
    expect(stats.readCount).toBe(0);
    expect(stats.readRate).toBe(0);
    await svc.markAsRead(1, 1, null, null);
    const after = await svc.getReadStats(1);
    expect(after.readCount).toBe(1);
    expect(after.unreadCount).toBe(3);
    expect(after.readRate).toBe(25);
    expect(after.readUsers.map((u: any) => u.userId)).toEqual([1]);
    // 组范围公告的受众只含组内启用用户
    const groupStats = await svc.getReadStats(2);
    expect(groupStats.targetCount).toBe(3); // 组 1 + 组 2 的用户（1/2/3），作者 9 不在组内
  });
});
