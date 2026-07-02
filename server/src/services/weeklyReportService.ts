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
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  // L4：service 实例缓存，避免每次 getter 访问都 new（构造轻量但频繁创建浪费）
  private _approvalInstanceService?: ApprovalInstanceService;
  private _notificationService?: NotificationService;
  private get approvalInstanceService() {
    return this._approvalInstanceService ?? (this._approvalInstanceService = new ApprovalInstanceService(this.manager));
  }
  private get notificationService() {
    return this._notificationService ?? (this._notificationService = new NotificationService(this.manager));
  }

  async createOrUpdate(data: { userId: number; weekStart: string; weekEnd: string; content?: string; summary?: string; totalHours?: number }) {
    // 并发保护：用事务 + 唯一约束兜底。两个请求同时 findOne 都返回 null 时，第二个 insert 会触发
    // 唯一约束（uq_weekly_report_user_week）报错，此处捕获后转为 update 重试，避免裸 DB 错误。
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WeeklyReport);
      const existing = await repo.findOne({
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
        return repo.save(existing);
      }

      try {
        const record = repo.create({
          userId: data.userId,
          weekStart: data.weekStart,
          weekEnd: data.weekEnd,
          content: data.content ?? '',
          summary: data.summary ?? '',
          totalHours: data.totalHours ?? 0,
          status: 'draft',
        });
        return await repo.save(record);
      } catch (e: any) {
        // 唯一约束冲突（SQLite: SQLITE_CONSTRAINT_UNIQUE / 消息含 UNIQUE；Postgres: 23505）：
        // 并发请求已创建该周报，重新查询并转为更新
        if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === '23505' || String(e?.message || '').includes('UNIQUE')) {
          const existing2 = await repo.findOne({ where: { userId: data.userId, weekStart: data.weekStart } });
          if (existing2) {
            if (existing2.status !== 'draft' && existing2.status !== 'rejected') throw new BusinessError('已提交或已审批的周报不可修改');
            existing2.weekEnd = data.weekEnd;
            existing2.content = data.content ?? '';
            existing2.summary = data.summary ?? '';
            existing2.totalHours = data.totalHours ?? 0;
            return repo.save(existing2);
          }
        }
        throw e;
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

    await AppDataSource.transaction(async (manager) => {
      const txService = new WeeklyReportService(manager);
      // 乐观锁抢占：条件 UPDATE 把 draft 改成 submitting，affected=0 说明已被并发提交，阻止重复审批。
      // 替代原先无效的 pessimistic_write（better-sqlite3 driver 静默忽略该锁模式，双击会产生重复审批实例）。
      const record = await txService.repo.findOne({ where: { id } });
      if (!record) throw new BusinessError('周报不存在');
      if (record.userId !== userId) throw new BusinessError('只能提交自己的周报');

      const claim = await txService.repo.update({ id, status: 'draft' }, { status: 'submitting' });
      if (!claim.affected) throw new BusinessError('该周报不在可提交状态，可能已提交或被修改');

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
