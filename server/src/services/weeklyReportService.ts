import { AppDataSource } from '../config/database';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationService } from './notificationService';
import { User } from '../entities/User';

export class WeeklyReportService {
  private repo = AppDataSource.getRepository(WeeklyReport);
  private approvalInstanceService = new ApprovalInstanceService();
  private notificationService = new NotificationService();
  private userRepo = AppDataSource.getRepository(User);

  async createOrUpdate(data: { userId: number; weekStart: string; weekEnd: string; content?: string; summary?: string; totalHours?: number }) {
    const existing = await this.repo.findOne({
      where: { userId: data.userId, weekStart: data.weekStart },
    });

    if (existing) {
      if (existing.status !== 'draft' && existing.status !== 'rejected') throw new Error('已提交或已审批的周报不可修改');
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

  /** 提交周报 — 解析审批流程 */
  async submit(id: number, userId: number) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new Error('周报不存在');
    if (record.userId !== userId) throw new Error('只能提交自己的周报');
    if (record.status !== 'draft') throw new Error('仅草稿状态可提交');

    const resolved = await this.approvalInstanceService.start({
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
      const submitter = await this.userRepo.findOneBy({ id: userId });
      if (submitter && resolved.firstApproverIds.length) {
        await this.notificationService.notifyApprovalPending(
          resolved.firstApproverIds,
          'weekly_report',
          record.id,
          submitter.realName,
          `周报审批 ${record.weekStart}~${record.weekEnd}`,
        );
      }
    } else {
      record.status = 'approved';
      record.currentStep = 0;
      record.totalSteps = 0;
      record.approvalInstanceId = resolved.instance?.id ?? null;
    }

    await this.repo.save(record);
    return true;
  }
}
