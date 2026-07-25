import { EntityManager } from 'typeorm';
import { BusinessError, isUniqueViolation } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { WeeklyReport } from '../entities/WeeklyReport';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationPublisher } from './notifications';
import { User } from '../entities/User';
import { TimesheetService } from './timesheetService';

export class WeeklyReportService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(WeeklyReport); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get timesheetService() { return new TimesheetService(this.manager); }

  private transaction<T>(callback: (manager: EntityManager) => Promise<T>): Promise<T> {
    // 仅当传入 manager 已在活动事务中时复用；否则开启新事务（pessimistic_write 行锁需要活动事务）
    if (this.manager?.queryRunner?.isTransactionActive) return callback(this.manager);
    return (this.manager?.connection ?? AppDataSource).transaction(callback);
  }

  private validateWeekRange(weekStart: string, weekEnd: string) {
    const start = Date.parse(`${weekStart}T00:00:00Z`);
    const end = Date.parse(`${weekEnd}T00:00:00Z`);
    if (new Date(start).getUTCDay() !== 1 || end - start !== 6 * 24 * 60 * 60 * 1000) {
      throw new BusinessError('周报周期必须从周一开始并连续覆盖 7 天');
    }
  }

  async createOrUpdate(data: { userId: number; weekStart: string; weekEnd: string; content?: string; summary?: string; totalDays?: number }) {
    this.validateWeekRange(data.weekStart, data.weekEnd);
    // 包入事务并对已有行加写锁，串行化同用户同周的并发编辑，避免 last-write-wins 丢更新
    return this.transaction(async (manager) => {
      const txService = new WeeklyReportService(manager);
      const weeklySummary = await txService.timesheetService.getWeeklySummary(data.userId, data.weekStart, data.weekEnd, { approvedOnly: true });
      const existing = await txService.repo.findOne({
        where: { userId: data.userId, weekStart: data.weekStart },
        lock: { mode: 'pessimistic_write' },
      });

      if (existing) {
        if (!['draft', 'rejected', 'withdrawn'].includes(existing.status)) {
          throw new BusinessError('审批中或已通过的周报不可修改');
        }
        existing.weekEnd = data.weekEnd;
        existing.content = data.content ?? '';
        existing.summary = data.summary ?? '';
        existing.totalDays = weeklySummary.totalDays;
        if (existing.status === 'rejected' || existing.status === 'withdrawn') {
          existing.status = 'draft';
          existing.currentStep = 0;
          existing.approvalFlowId = null;
          existing.approvalInstanceId = null;
          existing.totalSteps = 0;
        }
        return txService.repo.save(existing);
      }

      const record = txService.repo.create({
        userId: data.userId,
        weekStart: data.weekStart,
        weekEnd: data.weekEnd,
        content: data.content ?? '',
        summary: data.summary ?? '',
        totalDays: weeklySummary.totalDays,
        status: 'draft',
      });
      try {
        return await txService.repo.save(record);
      } catch (err) {
        // 并发新建同周撞 uq_weekly_report_user_week
        if (isUniqueViolation(err)) throw new BusinessError('该周报已存在，请刷新后重试');
        throw err;
      }
    });
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

    await this.transaction(async (manager) => {
      const txService = new WeeklyReportService(manager);
      const record = await txService.repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!record) throw new BusinessError('周报不存在');
      if (record.userId !== userId) throw new BusinessError('只能提交自己的周报');
      if (record.status !== 'draft') throw new BusinessError('仅草稿状态可提交');
      if (!record.content?.trim()) throw new BusinessError('请填写周报内容后再提交');

      // 提交时刷新 totalDays，避免草稿态陈旧值被带入审批（审批人据此判断工时是否合理）
      const summary = await txService.timesheetService.getWeeklySummary(record.userId, record.weekStart, record.weekEnd, { approvedOnly: true });
      record.totalDays = summary.totalDays;

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
    }).catch((err) => {
      // 并发提交撞 approval_instances 的 (targetType,targetId) 活跃唯一索引
      if (isUniqueViolation(err)) throw new BusinessError('该周报已提交，请刷新后重试');
      throw err;
    });

    const notifier = new NotificationPublisher();
    for (const n of notifications) {
      try { await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title); } catch {}
    }
    return true;
  }
}
