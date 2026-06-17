import { EntityManager } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationService } from './notificationService';
import { User } from '../entities/User';

export class WeeklyReportService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(WeeklyReport); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get notificationService() { return new NotificationService(this.manager); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }

  async createOrUpdate(data: { userId: number; weekStart: string; weekEnd: string; content?: string; summary?: string; totalHours?: number }) {
    const existing = await this.repo.findOne({
      where: { userId: data.userId, weekStart: data.weekStart },
    });

    if (existing) {
      if (existing.status !== 'draft' && existing.status !== 'rejected') throw new BusinessError('已提交或已审批的周报不可修改');
      existing.weekEnd = data.weekEnd;
      existing.content = data.content ?? '';
      existing.summary = data.summary ?? '';
      existing.totalHours = data.totalHours ?? 0;
      if (existing.status === 'rejected') {
        existing.status = 'draft';
        existing.currentStep = 0;
        existing.approvalFlowId = null;
        existing.approvalInstanceId = null;
        existing.totalSteps = 0;
      }
      return this.repo.save(existing);
    }

    const record = this.repo.create({
      userId: data.userId,
      weekStart: data.weekStart,
      weekEnd: data.weekEnd,
      content: data.content ?? '',
      summary: data.summary ?? '',
      totalHours: data.totalHours ?? 0,
      status: 'draft',
    });
    return this.repo.save(record);
  }

  async getByUser(userId: number, params: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = params;
    const [list, total] = await this.repo.findAndCount({
      where: { userId },
      order: { weekStart: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { list, total, page, pageSize };
  }

  async getByWeek(userId: number, weekStart: string) {
    return this.repo.findOne({
      where: { userId, weekStart },
    });
  }

  /** 提交周报 — 解析审批流程（事务化，通知外置） */
  async submit(id: number, userId: number) {
    type PendingNotify = { approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string };
    const notifications: PendingNotify[] = [];

    await AppDataSource.transaction(async (manager) => {
      const txService = new WeeklyReportService(manager);
      const record = await txService.repo.findOne({ where: { id } });
      if (!record) throw new BusinessError('周报不存在');
      if (record.userId !== userId) throw new BusinessError('只能提交自己的周报');
      if (record.status !== 'draft') throw new BusinessError('仅草稿状态可提交');

      const resolved = await txService.approvalInstanceService.start({
        targetType: 'weekly_report',
        targetId: record.id,
        applicantId: userId,
      });
      if (resolved.status === 'submitted' && resolved.instance) {
        record.status = 'submitted';
        record.currentStep = resolved.instance.currentStepOrder || 1;
        record.approvalFlowId = resolved.instance.flowId;
        record.approvalInstanceId = resolved.instance.id;
        record.totalSteps = resolved.instance.totalSteps;
        if (resolved.firstApproverIds.length) {
          const submitter = await txService.userRepo.findOneBy({ id: userId });
          if (submitter) {
            notifications.push({
              approverIds: resolved.firstApproverIds,
              targetType: 'weekly_report',
              targetId: record.id,
              applicantName: submitter.realName,
              title: `周报审批 ${record.weekStart}~${record.weekEnd}`,
            });
          }
        }
      } else {
        record.status = 'approved';
        record.currentStep = 0;
        record.totalSteps = 0;
        record.approvalInstanceId = resolved.instance?.id ?? null;
      }

      await txService.repo.save(record);
    });

    const notifier = new NotificationService();
    for (const n of notifications) {
      try { await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title); } catch {}
    }
    return true;
  }
}
