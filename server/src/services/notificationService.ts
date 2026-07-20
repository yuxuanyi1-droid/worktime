import { EntityManager, In } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { Notification } from '../entities/Notification';

export class NotificationService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(Notification); }

  /** 创建通知 */
  async create(data: {
    userId: number;
    type: string;
    title: string;
    content?: string;
    targetType?: string;
    targetId?: number;
  }) {
    const notification = this.repo.create(data);
    return this.repo.save(notification);
  }

  /** 批量创建通知（发送给多个人） */
  async createBatch(userIds: number[], data: {
    type: string;
    title: string;
    content?: string;
    targetType?: string;
    targetId?: number;
  }) {
    if (!userIds?.length) return [];
    const notifications = userIds.map(uid => this.repo.create({ ...data, userId: uid }));
    return this.repo.save(notifications);
  }

  /** 获取用户的通知列表 */
  async getByUser(userId: number, params: { isRead?: boolean; page?: number; pageSize?: number }) {
    const { isRead, page = 1, pageSize = 20 } = params;
    const qb = this.repo.createQueryBuilder('n')
      .where('n.userId = :userId', { userId });

    if (isRead !== undefined) {
      qb.andWhere('n.isRead = :isRead', { isRead });
    }

    qb.orderBy('n.createdAt', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    return { list, total, page, pageSize };
  }

  /** 获取未读数量 */
  async getUnreadCount(userId: number) {
    return this.repo.count({ where: { userId, isRead: false } });
  }

  /** 标记已读 */
  async markAsRead(userId: number, ids: number[]) {
    if (ids.length === 0) return;
    await this.repo.update({ userId, id: In(ids) }, { isRead: true });
  }

  /** 标记全部已读 */
  async markAllAsRead(userId: number) {
    await this.repo.update({ userId, isRead: false }, { isRead: true });
  }

  /** 删除通知 */
  async delete(userId: number, id: number) {
    const notification = await this.repo.findOne({ where: { id } });
    if (!notification) throw new BusinessError('通知不存在');
    if (notification.userId !== userId) throw new BusinessError('只能删除自己的通知');
    await this.repo.delete(id);
  }

}
