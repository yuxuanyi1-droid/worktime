import { In } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { User } from '../../entities/User';
import { logger } from '../../utils/logger';
import { NotificationService } from '../notificationService';
import { TtMessage, TtRobotClient } from './ttRobotClient';

export interface PublishNotificationInput {
  type: string;
  title: string;
  content?: string;
  targetType?: string;
  targetId?: number;
}

export interface PublishNotificationOptions {
  /** 是否发送 TT 通知；默认 true，未启用 TT 配置时自动跳过。 */
  sendToTt?: boolean;
  /** 自定义 TT 消息；未提供时使用“标题 + 内容”的文本消息。 */
  ttMessage?: TtMessage;
  /** TT 失败是否抛出；默认 false，保证外部通道不影响站内通知和业务结果。 */
  throwOnTtFailure?: boolean;
}

export type TtPublishStatus = 'disabled' | 'skipped' | 'sent' | 'failed';
export type TtRecipientResolver = (userIds: number[]) => Promise<string[]>;

async function resolveRecipientsByUsername(userIds: number[]): Promise<string[]> {
  const users = await AppDataSource.getRepository(User).find({
    select: { id: true, username: true },
    where: { id: In(userIds), status: 1 },
  });
  return users.map(user => user.username.trim()).filter(Boolean);
}

/**
 * 统一通知发布入口。
 *
 * 业务应在事务提交后调用：先持久化站内通知，再 best-effort 推送 TT。后续新增功能
 * 只需调用 publishToUser/publishToUsers，不需要了解签名、分批和接收人工号解析细节。
 */
export class NotificationPublisher {
  constructor(
    private readonly inApp = new NotificationService(),
    private readonly tt = new TtRobotClient(),
    private readonly resolveTtRecipients: TtRecipientResolver = resolveRecipientsByUsername,
  ) {}

  async publishToUser(
    userId: number,
    notification: PublishNotificationInput,
    options: PublishNotificationOptions = {},
  ) {
    const result = await this.publishToUsers([userId], notification, options);
    return { notification: result.notifications[0], ttStatus: result.ttStatus };
  }

  async publishToUsers(
    userIds: number[],
    notification: PublishNotificationInput,
    options: PublishNotificationOptions = {},
  ) {
    const uniqueUserIds = Array.from(new Set(userIds.filter(id => Number.isInteger(id) && id > 0)));
    const notifications = await this.inApp.createBatch(uniqueUserIds, notification);
    const ttStatus = await this.publishToTt(uniqueUserIds, notification, options);
    return { notifications, ttStatus };
  }

  /** 发送审批待办通知（站内 + 可选 TT）。 */
  async notifyApprovalPending(
    approverIds: number[],
    targetType: string,
    targetId: number,
    applicantName: string,
    title: string,
  ) {
    const typeLabel = this.getApprovalTypeLabel(targetType);
    return this.publishToUsers(approverIds, {
      type: 'approval_pending',
      title: `待审批：${title}`,
      content: `${applicantName} 提交了一份${typeLabel}申请，请及时审批`,
      targetType,
      targetId,
    });
  }

  /** 发送审批结果通知（站内 + 可选 TT）。 */
  async notifyApprovalResult(
    applicantId: number,
    targetType: string,
    targetId: number,
    approved: boolean,
    comment?: string,
  ) {
    const actionLabel = approved ? '已通过' : '已驳回';
    const typeLabel = this.getApprovalTypeLabel(targetType);
    return this.publishToUser(applicantId, {
      type: approved ? 'approval_approved' : 'approval_rejected',
      title: `${typeLabel}申请${actionLabel}`,
      content: comment || `您的${typeLabel}申请已${actionLabel}`,
      targetType,
      targetId,
    });
  }

  private getApprovalTypeLabel(targetType: string): string {
    const labels: Record<string, string> = {
      timesheet: '工时',
      overtime: '加班',
      weekly_report: '周报',
      permission_request: '权限',
    };
    return labels[targetType] || '审批';
  }

  private async publishToTt(
    userIds: number[],
    notification: PublishNotificationInput,
    options: PublishNotificationOptions,
  ): Promise<TtPublishStatus> {
    if (options.sendToTt === false) return 'skipped';
    if (!this.tt.enabled) return 'disabled';
    if (!userIds.length) return 'skipped';

    try {
      const employeeIds = await this.resolveTtRecipients(userIds);
      if (!employeeIds.length) return 'skipped';

      const message = options.ttMessage ?? {
        type: 2 as const,
        msg: { text: [notification.title, notification.content].filter(Boolean).join('\n') },
      };
      await this.tt.batchSendMessages(employeeIds, message);
      return 'sent';
    } catch (error) {
      logger.warn({ err: error, userCount: userIds.length }, 'TT 通知发送失败，已保留站内通知');
      if (options.throwOnTtFailure) throw error;
      return 'failed';
    }
  }
}
