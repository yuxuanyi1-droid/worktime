import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Announcement, AnnouncementType, TargetScope } from '../entities/Announcement';
import { AnnouncementRead } from '../entities/AnnouncementRead';
import { User } from '../entities/User';
import { In, Not, IsNull } from 'typeorm';
import { BusinessError } from '../utils/errors';

export class AnnouncementService {
  constructor(private manager?: EntityManager) {}

  private get announceRepo() { return (this.manager ?? AppDataSource).getRepository(Announcement); }
  private get readRepo() { return (this.manager ?? AppDataSource).getRepository(AnnouncementRead); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }

  /**
   * 构造「公告对用户可见」的 SQL where 条件（下推可见性判断，避免全表扫+内存过滤）。
   * - all：所有人可见
   * - department：targetDeptId = 用户部门
   * - user：targetUserIds（simple-json 字符串）包含 userId
   */
  private buildVisibleWhere(userId: number, userDeptId: number | null) {
    const conditions: string[] = [
      'a.targetScope = :scopeAll',
    ];
    const params: Record<string, unknown> = { scopeAll: 'all' };

    if (userDeptId !== null) {
      conditions.push('(a.targetScope = :scopeDept AND a.targetDeptId = :deptId)');
      params.scopeDept = 'department';
      params.deptId = userDeptId;
    }
    // targetUserIds 存储为 simple-json（如 "[1,2,3]"），用 LIKE 匹配（SQLite 无原生 JSON 数组查询）
    conditions.push("(a.targetScope = :scopeUser AND a.targetUserIds LIKE :userLike)");
    params.scopeUser = 'user';
    // 用逗号包裹避免 11 误匹配 1：匹配 ",1," / "[1," / ",1]"
    params.userLike = `%"${userId}"%`;

    return { where: conditions.join(' OR '), params };
  }

  /** 创建公告 */
  async create(data: {
    title: string;
    content?: string;
    type?: AnnouncementType;
    targetScope: TargetScope;
    targetDeptId?: number;
    targetUserIds?: number[];
    createdById: number;
  }) {
    const announcement = this.announceRepo.create(data);
    return this.announceRepo.save(announcement);
  }

  /** 获取所有公告（管理端）。E14：映射 createdByName，不泄漏完整 user 对象，与 getForUser 一致 */
  async getList(params: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = params;
    const [records, total] = await this.announceRepo.findAndCount({
      relations: ['createdBy'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const list = records.map(a => ({ ...a, createdBy: undefined, createdByName: a.createdBy?.realName || '' }));
    return { list, total, page, pageSize };
  }

  /** 获取公告详情。E14：映射 createdByName */
  async getById(id: number) {
    const a = await this.announceRepo.findOne({ where: { id }, relations: ['createdBy'] });
    if (!a) return null;
    return { ...a, createdBy: undefined, createdByName: a.createdBy?.realName || '' };
  }

  /** 更新公告（M1：校验作者或 admin，防越权改他人公告） */
  async update(id: number, data: Partial<Announcement>, operatorId: number, isAdmin: boolean) {
    const announcement = await this.announceRepo.findOne({ where: { id } });
    if (!announcement) throw new BusinessError('公告不存在');
    if (!isAdmin && announcement.createdById !== operatorId) {
      throw new BusinessError('只能修改自己创建的公告');
    }
    await this.announceRepo.update(id, data);
    // F5：返回值映射 createdByName，不泄漏完整 user 对象（与 getList/getById 一致）
    const updated = await this.announceRepo.findOne({ where: { id }, relations: ['createdBy'] });
    if (!updated) return null;
    return { ...updated, createdBy: undefined, createdByName: updated.createdBy?.realName || '' };
  }

  /** 删除公告（M1：校验作者或 admin；M2：事务化两步删除避免不一致） */
  async delete(id: number, operatorId: number, isAdmin: boolean) {
    const announcement = await this.announceRepo.findOne({ where: { id } });
    if (!announcement) throw new BusinessError('公告不存在');
    if (!isAdmin && announcement.createdById !== operatorId) {
      throw new BusinessError('只能删除自己创建的公告');
    }
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(AnnouncementRead).delete({ announcementId: id });
      await manager.getRepository(Announcement).delete(id);
    });
  }

  /**
   * 获取用户可见的公告列表（含已读状态）。
   * M4：可见性 + isRead 过滤 + 分页全部下推 SQL，避免全量加载到内存再 slice。
   */
  async getForUser(userId: number, userDeptId: number | null, params: { page?: number; pageSize?: number; isRead?: boolean }) {
    const { page = 1, pageSize = 20, isRead } = params;
    const { where, params: whereParams } = this.buildVisibleWhere(userId, userDeptId);

    // LEFT JOIN 已读表，r.id IS NULL 表示未读；LEFT JOIN createdBy 以取发布人名称
    const qb = this.announceRepo.createQueryBuilder('a')
      .leftJoinAndSelect('a.createdBy', 'creator')
      .leftJoin(AnnouncementRead, 'r', 'r.announcementId = a.id AND r.userId = :readUserId', { readUserId: userId })
      .where(`(${where})`, whereParams);
    if (isRead === true) qb.andWhere('r.id IS NOT NULL');
    else if (isRead === false) qb.andWhere('r.id IS NULL');

    const [announcements, total] = await qb
      .orderBy('a.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    // 批量查已读状态（仅当前页）
    const pageIds = announcements.map(a => a.id);
    const reads = pageIds.length ? await this.readRepo.find({ where: { userId, announcementId: In(pageIds) } }) : [];
    const readSet = new Set(reads.map(r => r.announcementId));

    const list = announcements.map(a => ({
      ...a,
      createdBy: undefined, // 不向前端泄漏完整 user 对象
      createdByName: a.createdBy?.realName || '',
      isRead: readSet.has(a.id),
    }));

    return { list, total, page, pageSize };
  }

  /** 获取用户未读公告数量（SQL COUNT 聚合，不再 materialize 全部行） */
  async getUnreadCount(userId: number, userDeptId: number | null) {
    const { where, params } = this.buildVisibleWhere(userId, userDeptId);
    const result = await this.announceRepo.createQueryBuilder('a')
      .leftJoin(AnnouncementRead, 'r', 'r.announcementId = a.id AND r.userId = :readUserId', { readUserId: userId })
      .where(`(${where})`, params)
      .andWhere('r.id IS NULL')
      .getCount();
    return result;
  }

  /** 标记公告已读 */
  async markAsRead(userId: number, announcementId: number) {
    const existing = await this.readRepo.findOne({ where: { userId, announcementId } });
    if (!existing) {
      await this.readRepo.save(this.readRepo.create({ userId, announcementId }));
    }
  }

  /** 批量标记可见公告已读（SQL 下推可见性） */
  async markAllAsRead(userId: number, userDeptId: number | null) {
    const { where, params } = this.buildVisibleWhere(userId, userDeptId);
    const visible = await this.announceRepo.createQueryBuilder('a')
      .select(['a.id'])
      .where(where, params)
      .getRawMany<{ id: number }>();
    const visibleIds = visible.map(v => v.id);
    if (visibleIds.length === 0) return;

    const reads = await this.readRepo.find({ where: { userId, announcementId: In(visibleIds) } });
    const readSet = new Set(reads.map(r => r.announcementId));
    const unreadIds = visibleIds.filter(id => !readSet.has(id));
    if (unreadIds.length > 0) {
      const entities = unreadIds.map(id => this.readRepo.create({ userId, announcementId: id }));
      await this.readRepo.save(entities);
    }
  }

  /** 获取公告已读统计（管理端） */
  async getReadStats(announcementId: number) {
    const announcement = await this.announceRepo.findOne({ where: { id: announcementId } });
    if (!announcement) throw new BusinessError('公告不存在');

    // 计算目标用户数
    let targetCount = 0;
    if (announcement.targetScope === 'all') {
      targetCount = await this.userRepo.count({ where: { status: 1 } });
    } else if (announcement.targetScope === 'department' && announcement.targetDeptId) {
      targetCount = await this.userRepo.count({
        where: { department: { id: announcement.targetDeptId }, status: 1 },
        relations: ['department'],
      });

    } else if (announcement.targetScope === 'user' && announcement.targetUserIds?.length) {
      targetCount = await this.userRepo.count({ where: { id: In(announcement.targetUserIds), status: 1 } });
    }

    const readCount = await this.readRepo.count({ where: { announcementId } });
    const readUsers = await this.readRepo.find({
      where: { announcementId },
      relations: ['user'],
      order: { readAt: 'ASC' },
    });

    return {
      targetCount,
      readCount,
      unreadCount: Math.max(0, targetCount - readCount),
      readRate: targetCount > 0 ? Math.round((readCount / targetCount) * 100) : 0,
      readUsers: readUsers.map(r => ({
        userId: r.userId,
        realName: (r as any).user?.realName || '',
        readAt: r.readAt,
      })),
    };
  }
}
