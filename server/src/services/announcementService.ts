import { AppDataSource } from '../config/database';
import { Announcement, AnnouncementType, TargetScope } from '../entities/Announcement';
import { AnnouncementRead } from '../entities/AnnouncementRead';
import { User } from '../entities/User';
import { In, Not, IsNull } from 'typeorm';

export class AnnouncementService {
  private announceRepo = AppDataSource.getRepository(Announcement);
  private readRepo = AppDataSource.getRepository(AnnouncementRead);
  private userRepo = AppDataSource.getRepository(User);

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

  /** 获取所有公告（管理端） */
  async getList(params: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = params;
    const [list, total] = await this.announceRepo.findAndCount({
      relations: ['createdBy'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total, page, pageSize };
  }

  /** 获取公告详情 */
  async getById(id: number) {
    return this.announceRepo.findOne({ where: { id }, relations: ['createdBy'] });
  }

  /** 更新公告 */
  async update(id: number, data: Partial<Announcement>) {
    await this.announceRepo.update(id, data);
    return this.announceRepo.findOne({ where: { id } });
  }

  /** 删除公告 */
  async delete(id: number) {
    await this.readRepo.delete({ announcementId: id });
    await this.announceRepo.delete(id);
  }

  /** 获取用户可见的公告列表（含已读状态） */
  async getForUser(userId: number, userDeptId: number | null, params: { page?: number; pageSize?: number; isRead?: boolean }) {
    const { page = 1, pageSize = 20, isRead } = params;

    // 获取用户可见的公告ID
    const allAnnouncements = await this.announceRepo.find({
      order: { createdAt: 'DESC' },
    });

    const visibleIds: number[] = [];
    for (const a of allAnnouncements) {
      if (this.isVisibleToUser(a, userId, userDeptId)) {
        visibleIds.push(a.id);
      }
    }

    if (visibleIds.length === 0) {
      return { list: [], total: 0, page, pageSize };
    }

    // 获取用户已读记录
    const reads = await this.readRepo.find({ where: { userId, announcementId: In(visibleIds) } });
    const readSet = new Set(reads.map(r => r.announcementId));

    let filteredIds = visibleIds;
    if (isRead === true) {
      filteredIds = visibleIds.filter(id => readSet.has(id));
    } else if (isRead === false) {
      filteredIds = visibleIds.filter(id => !readSet.has(id));
    }

    const total = filteredIds.length;
    const pagedIds = filteredIds.slice((page - 1) * pageSize, page * pageSize);

    if (pagedIds.length === 0) {
      return { list: [], total, page, pageSize };
    }

    const announcements = await this.announceRepo.find({
      where: { id: In(pagedIds) },
      relations: ['createdBy'],
      order: { createdAt: 'DESC' },
    });

    const list = announcements.map(a => ({
      ...a,
      isRead: readSet.has(a.id),
      createdBy: undefined,
      createdByName: a.createdBy?.realName || '',
    }));

    return { list, total, page, pageSize };
  }

  /** 获取用户未读公告数量 */
  async getUnreadCount(userId: number, userDeptId: number | null) {
    const allAnnouncements = await this.announceRepo.find();
    const visibleIds: number[] = [];
    for (const a of allAnnouncements) {
      if (this.isVisibleToUser(a, userId, userDeptId)) {
        visibleIds.push(a.id);
      }
    }

    if (visibleIds.length === 0) return 0;

    const reads = await this.readRepo.find({ where: { userId, announcementId: In(visibleIds) } });
    const readSet = new Set(reads.map(r => r.announcementId));

    return visibleIds.filter(id => !readSet.has(id)).length;
  }

  /** 标记公告已读 */
  async markAsRead(userId: number, announcementId: number) {
    const existing = await this.readRepo.findOne({ where: { userId, announcementId } });
    if (!existing) {
      await this.readRepo.save(this.readRepo.create({ userId, announcementId }));
    }
  }

  /** 批量标记公告已读 */
  async markAllAsRead(userId: number, userDeptId: number | null) {
    const allAnnouncements = await this.announceRepo.find();
    const visibleIds: number[] = [];
    for (const a of allAnnouncements) {
      if (this.isVisibleToUser(a, userId, userDeptId)) {
        visibleIds.push(a.id);
      }
    }

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
    if (!announcement) throw new Error('公告不存在');

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

  /** 判断公告是否对用户可见 */
  private isVisibleToUser(announcement: Announcement, userId: number, userDeptId: number | null): boolean {
    if (announcement.targetScope === 'all') return true;
    if (announcement.targetScope === 'department') {
      return announcement.targetDeptId === userDeptId;
    }
    if (announcement.targetScope === 'user') {
      return announcement.targetUserIds?.includes(userId) || false;
    }
    return false;
  }
}
