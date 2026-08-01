import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Announcement, AnnouncementType, TargetScope } from '../entities/Announcement';
import { AnnouncementRead } from '../entities/AnnouncementRead';
import { Group } from '../entities/Group';
import { User } from '../entities/User';
import { In } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { logger } from '../utils/logger';
import { NotificationPublisher, TtPublishStatus } from './notifications/notificationPublisher';
import { UserAudienceService } from './notifications/userAudienceService';

export class AnnouncementService {
  constructor(private manager?: EntityManager) {}

  private get announceRepo() { return (this.manager ?? AppDataSource).getRepository(Announcement); }
  private get readRepo() { return (this.manager ?? AppDataSource).getRepository(AnnouncementRead); }
  private get groupRepo() { return (this.manager ?? AppDataSource).getRepository(Group); }
  private get audienceService() { return new UserAudienceService(this.manager); }

  /**
   * 构造「公告对用户可见」的 SQL where 条件（下推可见性判断，避免全表扫+内存过滤）。
   * - all：所有人可见
   * - department：targetDeptId = 用户部门
   * - group：用户当前分组或任一上级分组
   * - user：targetUserIds（simple-json 字符串）包含 userId
   */
  private buildVisibleWhere(userId: number, userDeptId: number | null, userGroupIds: number[]) {
    const conditions: string[] = [
      'a.targetScope = :scopeAll',
    ];
    const params: Record<string, unknown> = { scopeAll: 'all' };

    if (userDeptId !== null) {
      conditions.push('(a.targetScope = :scopeDept AND a.targetDeptId = :deptId)');
      params.scopeDept = 'department';
      params.deptId = userDeptId;
    }
    if (userGroupIds.length) {
      conditions.push('(a.targetScope = :scopeGroup AND a.targetGroupId IN (:...userGroupIds))');
      params.scopeGroup = 'group';
      params.userGroupIds = userGroupIds;
    }
    // targetUserIds 存储为 simple-json（如 "[1,2,3]"），兼容 SQLite/PostgreSQL 文本查询。
    conditions.push(`(a.targetScope = :scopeUser AND (
      a.targetUserIds = :userOnly OR a.targetUserIds LIKE :userFirst
      OR a.targetUserIds LIKE :userMiddle OR a.targetUserIds LIKE :userLast
    ))`);
    params.scopeUser = 'user';
    params.userOnly = `[${userId}]`;
    params.userFirst = `[${userId},%`;
    params.userMiddle = `%,${userId},%`;
    params.userLast = `%,${userId}]`;

    // 整体加括号，确保调用方继续追加 AND 条件时不会被 SQL 的 AND 优先级拆散。
    return { where: `(${conditions.join(' OR ')})`, params };
  }

  private async getUserGroupAncestorIds(userGroupId: number | null): Promise<number[]> {
    if (!userGroupId) return [];
    const group = await this.groupRepo.findOne({ where: { id: userGroupId } });
    if (!group) return [];
    return Array.from(new Set((group.path || String(group.id))
      .split('/')
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0)));
  }

  /** 创建公告 */
  async create(data: {
    title: string;
    content?: string | null;
    type?: AnnouncementType;
    targetScope: TargetScope;
    targetDeptId?: number;
    targetGroupId?: number;
    targetUserIds?: number[];
    createdById: number;
  }) {
    const userIds = await this.audienceService.resolveUserIds(data, { strict: true });
    const announcement = this.announceRepo.create({
      ...data,
      targetDeptId: data.targetScope === 'department' ? data.targetDeptId : null,
      targetGroupId: data.targetScope === 'group' ? data.targetGroupId : null,
      targetUserIds: data.targetScope === 'user' ? data.targetUserIds : null,
    });
    const saved = await this.announceRepo.save(announcement);

    // 公告本身就是站内载体，这里仅补发 TT；失败不会回滚已发布的公告。
    let ttStatus: TtPublishStatus = 'skipped';
    if (!this.manager) {
      try {
        ttStatus = await new NotificationPublisher().publishTtOnly(userIds, {
          type: 'announcement',
          title: `【${this.getTypeLabel(saved.type)}公告】${saved.title}`,
          content: saved.content || undefined,
          targetType: 'announcement',
          targetId: saved.id,
        });
      } catch (error) {
        ttStatus = 'failed';
        logger.warn({ err: error, announcementId: saved.id }, '公告已发布，但 TT 通知初始化失败');
      }
    }
    return { ...saved, ttStatus };
  }

  private getTypeLabel(type: AnnouncementType): string {
    return ({ info: '普通', important: '重要', urgent: '紧急' } as const)[type] || '普通';
  }

  /** 获取所有公告（管理端） */
  async getList(params: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = params;
    const [list, total] = await this.announceRepo.findAndCount({
      relations: ['createdBy'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      list: list.map(announcement => ({
        ...announcement,
        createdBy: undefined,
        createdByName: announcement.createdBy?.realName || '',
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 获取公告详情 */
  async getById(id: number) {
    return this.announceRepo.findOne({ where: { id }, relations: ['createdBy'] });
  }

  /** 更新公告 */
  async update(id: number, data: Partial<Announcement>) {
    const existing = await this.announceRepo.findOne({ where: { id } });
    if (!existing) throw new BusinessError('公告不存在');
    // 部分更新语义：targetScope 未提供（PUT 部分字段）时沿用原公告受众范围，
    // 避免默认 'all' 把「仅某部门可见」的公告静默改为全员可见。
    const merged = data.targetScope === undefined
      ? {
        ...data,
        targetScope: existing.targetScope,
        targetDeptId: existing.targetDeptId,
        targetGroupId: existing.targetGroupId,
        targetUserIds: existing.targetUserIds,
      }
      : data;
    await this.audienceService.resolveUserIds(merged as Announcement, { strict: true });
    await this.announceRepo.update(id, {
      ...merged,
      targetDeptId: merged.targetScope === 'department' ? merged.targetDeptId : null,
      targetGroupId: merged.targetScope === 'group' ? merged.targetGroupId : null,
      targetUserIds: merged.targetScope === 'user' ? merged.targetUserIds : null,
    });
    return this.announceRepo.findOne({ where: { id } });
  }

  /** 删除公告 */
  async delete(id: number): Promise<void> {
    if (!this.manager) {
      await AppDataSource.transaction(manager => new AnnouncementService(manager).delete(id));
      return;
    }
    const existing = await this.announceRepo.findOne({ where: { id } });
    if (!existing) throw new BusinessError('公告不存在', 404);
    await this.readRepo.delete({ announcementId: id });
    await this.announceRepo.delete(id);
  }

  /** 获取用户可见的公告列表（含已读状态）。可见性、已读过滤、计数与分页全部下推 DB。 */
  async getForUser(userId: number, userDeptId: number | null, userGroupId: number | null, params: { page?: number; pageSize?: number; isRead?: boolean }) {
    const { page = 1, pageSize = 20, isRead } = params;
    const userGroupIds = await this.getUserGroupAncestorIds(userGroupId);
    const { where, params: whereParams } = this.buildVisibleWhere(userId, userDeptId, userGroupIds);

    // 用 LEFT JOIN announcement_reads（限定本用户）把「是否已读」也下推 SQL：
    // - isRead=true  → r.id IS NOT NULL（存在已读记录）
    // - isRead=false → r.id IS NULL（不存在已读记录）
    // - isRead 未指定 → 不过滤
    // (announcementId, userId) 上有唯一约束，每条公告对本用户最多 1 条已读，LEFT JOIN 不会放大行数。
    const buildQb = () => this.announceRepo.createQueryBuilder('a')
      .leftJoin(AnnouncementRead, 'r', 'r.announcementId = a.id AND r.userId = :readUserId', { readUserId: userId })
      .where(where, whereParams);

    const applyReadFilter = (qb: ReturnType<typeof buildQb>) => {
      if (isRead === true) qb.andWhere('r.id IS NOT NULL');
      else if (isRead === false) qb.andWhere('r.id IS NULL');
      return qb;
    };

    // 计数也下推 DB：getCount 内部会生成 COUNT(DISTINCT a.id)，跳过 orderBy/skip/take。
    const total = await applyReadFilter(buildQb()).getCount();
    if (total === 0) return { list: [], total, page, pageSize };

    // 分页 + 排序 + 预加载创建人；id 作为次序保证分页稳定。
    const announcements = await applyReadFilter(buildQb())
      .leftJoinAndSelect('a.createdBy', 'cb')
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    // 当前页（上限 pageSize，已 bounded）的已读集合用一次小查询取回。
    const pageIds = announcements.map(a => a.id);
    const reads = pageIds.length
      ? await this.readRepo.find({
        where: { userId, announcementId: In(pageIds) },
        select: ['announcementId'],
      })
      : [];
    const readSet = new Set(reads.map(r => r.announcementId));

    const list = announcements.map(a => ({
      ...a,
      isRead: readSet.has(a.id),
      createdBy: undefined,
      createdByName: a.createdBy?.realName || '',
    }));

    return { list, total, page, pageSize };
  }

  /** 获取用户未读公告数量（COUNT 聚合下推 DB；可见性 WHERE + LEFT JOIN 已读 + IS NULL，单次查询） */
  async getUnreadCount(userId: number, userDeptId: number | null, userGroupId: number | null) {
    const userGroupIds = await this.getUserGroupAncestorIds(userGroupId);
    const { where, params } = this.buildVisibleWhere(userId, userDeptId, userGroupIds);
    // getCount 生成 COUNT(DISTINCT a.id)，不再用 getRawMany().length 把全部 id 拉回 JS 计数。
    return this.announceRepo.createQueryBuilder('a')
      .leftJoin(AnnouncementRead, 'r', 'r.announcementId = a.id AND r.userId = :readUserId', { readUserId: userId })
      .where(where, params)
      .andWhere('r.id IS NULL')
      .getCount();
  }

  /** 标记公告已读 */
  async markAsRead(
    userId: number,
    announcementId: number,
    userDeptId: number | null,
    userGroupId: number | null,
  ) {
    const userGroupIds = await this.getUserGroupAncestorIds(userGroupId);
    const { where, params } = this.buildVisibleWhere(userId, userDeptId, userGroupIds);
    const visible = await this.announceRepo.createQueryBuilder('a')
      .select(['a.id'])
      .where(where, params)
      .andWhere('a.id = :announcementId', { announcementId })
      .getOne();
    if (!visible) throw new BusinessError('公告不存在或不可见', 404);

    // 用 ON CONFLICT DO NOTHING 做幂等插入，替代 check-then-insert：
    // 并发场景下两个请求同时通过 findOne 检查再 save 会触发 (announcementId, userId) 唯一约束冲突并冒泡为 500。
    // TypeORM orIgnore() 在 PostgreSQL（生产）与 SQLite（better-sqlite3，测试）下均生成 ON CONFLICT DO NOTHING。
    await this.readRepo.createQueryBuilder()
      .insert()
      .into(AnnouncementRead)
      .values({ userId, announcementId })
      .orIgnore()
      .execute();
  }

  /** 批量标记可见公告已读（SQL 下推可见性；ON CONFLICT 批量幂等插入） */
  async markAllAsRead(userId: number, userDeptId: number | null, userGroupId: number | null) {
    const userGroupIds = await this.getUserGroupAncestorIds(userGroupId);
    const { where, params } = this.buildVisibleWhere(userId, userDeptId, userGroupIds);
    const visible = await this.announceRepo.createQueryBuilder('a')
      .select(['a.id'])
      .where(where, params)
      .getRawMany<{ id: number }>();
    const visibleIds = visible.map(announcement => announcement.id);
    if (visibleIds.length === 0) return;

    // 直接对所有可见公告做 ON CONFLICT DO NOTHING 批量插入，无需先 SELECT 已读再 diff：
    // 既消除 check-then-insert 并发冲突，又避免对庞大 visibleIds 做 IN(...) 查询。
    // SQLite 单语句参数上限 999，每行 2 列，按 400 一批切片保留余量；Postgres 无此约束。
    const BATCH = 400;
    for (let i = 0; i < visibleIds.length; i += BATCH) {
      const batch = visibleIds.slice(i, i + BATCH);
      await this.readRepo.createQueryBuilder()
        .insert()
        .into(AnnouncementRead)
        .values(batch.map(announcementId => ({ userId, announcementId })))
        .orIgnore()
        .execute();
    }
  }

  /**
   * 把公告的受众范围编译成针对 users 表（别名 u）的 SQL 过滤片段，避免把全体受众 user id 物化进内存。
   * 返回的 audienceWhere 直接用于：(1) COUNT 计算受众数；(2) JOIN 过滤已读名单。
   * 业务语义与 UserAudienceService.resolveUserIds 一致（仅在职用户 status=1）。
   */
  private async buildAudienceFilter(announcement: {
    targetScope: TargetScope;
    targetDeptId: number | null;
    targetGroupId: number | null;
    targetUserIds: number[] | null;
  }): Promise<{ audienceWhere: string; audienceParams: Record<string, unknown> }> {
    const activeStatus = 1;
    if (announcement.targetScope === 'all') {
      return {
        audienceWhere: 'u.status = :activeStatus',
        audienceParams: { activeStatus },
      };
    }
    if (announcement.targetScope === 'department') {
      if (!announcement.targetDeptId) throw new BusinessError('请选择目标部门');
      return {
        audienceWhere: 'u.status = :activeStatus AND u.departmentId = :deptId',
        audienceParams: { activeStatus, deptId: announcement.targetDeptId },
      };
    }
    if (announcement.targetScope === 'group') {
      if (!announcement.targetGroupId) throw new BusinessError('请选择目标分组');
      // group + 子分组 id 数量级小（组织树节点），物化无碍；不物化的是其下的全体 user id。
      const groupIds = await this.audienceService.getGroupAndDescendantIds(announcement.targetGroupId, false);
      if (!groupIds.length) return { audienceWhere: '0=1', audienceParams: {} };
      return {
        audienceWhere: 'u.status = :activeStatus AND u.groupId IN (:...groupIds)',
        audienceParams: { activeStatus, groupIds },
      };
    }
    // targetScope === 'user'：targetUserIds 来自公告字段（上限 2000），直接用 IN 过滤。
    const targetUserIds = Array.from(new Set(announcement.targetUserIds || []));
    if (!targetUserIds.length) throw new BusinessError('请选择目标用户');
    return {
      audienceWhere: 'u.status = :activeStatus AND u.id IN (:...targetUserIds)',
      audienceParams: { activeStatus, targetUserIds },
    };
  }

  /** 获取公告已读统计（管理端）：受众数走 COUNT 聚合，已读名单走带受众过滤的 JOIN，不再物化全体 user id。 */
  async getReadStats(announcementId: number) {
    const announcement = await this.announceRepo.findOne({ where: { id: announcementId } });
    if (!announcement) throw new BusinessError('公告不存在');

    const { audienceWhere, audienceParams } = await this.buildAudienceFilter(announcement);

    // 受众数 = COUNT(users WHERE 受众条件)，全员范围不再把所有 user id 拉进内存。
    const userRepo = (this.manager ?? AppDataSource).getRepository(User);
    const targetRow = await userRepo.createQueryBuilder('u')
      .select('COUNT(u.id)', 'cnt')
      .where(audienceWhere, audienceParams)
      .getRawOne<{ cnt: string | number }>();
    // Postgres COUNT 返回 bigint（字符串），SQLite 返回 number；统一 Number(...) 转换。
    const targetCount = Number(targetRow?.cnt ?? 0);
    // 受众为空时短路返回，避免对已读名单做无意义的 JOIN 查询。
    if (targetCount === 0) {
      return { targetCount: 0, readCount: 0, unreadCount: 0, readRate: 0, readUsers: [] };
    }

    // 已读名单 = announcement_reads JOIN users，且 user 满足当前受众条件。
    // 公告范围被编辑后，旧范围用户留下的已读记录会被当前 audienceWhere 自然过滤掉。
    const readUsers = await this.readRepo.createQueryBuilder('r')
      .innerJoinAndSelect('r.user', 'u')
      .where('r.announcementId = :announcementId', { announcementId })
      .andWhere(audienceWhere, audienceParams)
      .orderBy('r.readAt', 'ASC')
      .getMany();
    const readCount = readUsers.length;

    return {
      targetCount,
      readCount,
      unreadCount: Math.max(0, targetCount - readCount),
      readRate: targetCount > 0 ? Math.min(100, Math.round((readCount / targetCount) * 100)) : 0,
      readUsers: readUsers.map(r => ({
        userId: r.userId,
        realName: (r as any).user?.realName || '',
        readAt: r.readAt,
      })),
    };
  }
}
