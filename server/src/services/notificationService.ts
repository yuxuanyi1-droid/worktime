import { AppDataSource } from '../config/database';
import { Notification } from '../entities/Notification';
import { User } from '../entities/User';
import { Between, In } from 'typeorm';

export class NotificationService {
  private repo = AppDataSource.getRepository(Notification);
  private userRepo = AppDataSource.getRepository(User);

  private getApprovalTypeLabel(targetType: string) {
    const labels: Record<string, string> = {
      timesheet: '工时',
      overtime: '加班',
      weekly_report: '周报',
      permission_request: '权限',
    };
    return labels[targetType] || '审批';
  }

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
    if (!notification) throw new Error('通知不存在');
    if (notification.userId !== userId) throw new Error('只能删除自己的通知');
    await this.repo.delete(id);
  }

  /** 发送审批相关通知 */
  async notifyApprovalPending(approverIds: number[], targetType: string, targetId: number, applicantName: string, title: string) {
    const typeLabel = this.getApprovalTypeLabel(targetType);
    return this.createBatch(approverIds, {
      type: 'approval_pending',
      title: `待审批：${title}`,
      content: `${applicantName} 提交了一份${typeLabel}申请，请及时审批`,
      targetType,
      targetId,
    });
  }

  /** 通知申请人审批结果 */
  async notifyApprovalResult(applicantId: number, targetType: string, targetId: number, approved: boolean, comment?: string) {
    const actionLabel = approved ? '已通过' : '已驳回';
    const typeLabel = this.getApprovalTypeLabel(targetType);
    return this.create({
      userId: applicantId,
      type: approved ? 'approval_approved' : 'approval_rejected',
      title: `${typeLabel}申请${actionLabel}`,
      content: comment || `您的${typeLabel}申请已${actionLabel}`,
      targetType,
      targetId,
    });
  }
}
