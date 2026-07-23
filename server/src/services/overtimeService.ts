import { EntityManager } from 'typeorm';
import { BusinessError } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { OvertimeApplication, OvertimeType } from '../entities/OvertimeApplication';
import { Between, In } from 'typeorm';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationPublisher } from './notifications';
import { User } from '../entities/User';
import { AccessPolicyService } from './accessPolicyService';
import { Project } from '../entities/Project';

export function getOvertimeStatsDateRange(year: number, month?: number) {
  if (month) {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  }
  return {
    startDate: `${String(year).padStart(4, '0')}-01-01`,
    endDate: `${String(year + 1).padStart(4, '0')}-01-01`,
  };
}

export class OvertimeService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(OvertimeApplication); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get accessPolicy() { return new AccessPolicyService(this.manager); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get projectRepo() { return (this.manager ?? AppDataSource).getRepository(Project); }

  private transaction<T>(callback: (manager: EntityManager) => Promise<T>) {
    return this.manager ? callback(this.manager) : AppDataSource.transaction(callback);
  }

  private async ensureActiveProject(projectId?: number | null) {
    if (!projectId) throw new BusinessError('请选择加班项目');
    const project = await this.projectRepo.findOneBy({ id: projectId });
    if (!project || project.status !== 'active') throw new BusinessError('加班项目不存在或已停用');
  }

  async create(data: { userId: number; date?: string; overtimeType?: string; days?: number; reason?: string; projectId?: number }) {
    await this.ensureActiveProject(data.projectId);
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.repo.create({
      userId: data.userId,
      ...orgSnapshot,
      date: data.date!,
      overtimeType: data.overtimeType as OvertimeType,
      days: data.days!,
      reason: data.reason,
      projectId: data.projectId ?? null,
    });
    return this.repo.save(record);
  }

  async createAndSubmit(data: { userId: number; date?: string; overtimeType?: string; days?: number; reason?: string; projectId?: number }) {
    // 整体事务：create + submit 原子化，任一失败整体回滚，避免孤儿记录或误删
    const notifications: { approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string }[] = [];
    let createdId: number;

    await this.transaction(async (manager) => {
      const txService = new OvertimeService(manager);
      await txService.ensureActiveProject(data.projectId);
      // 1. 创建草稿
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(data.userId);
      const record = txService.repo.create({
        userId: data.userId,
        ...orgSnapshot,
        date: data.date!,
        overtimeType: data.overtimeType as OvertimeType,
        days: data.days!,
        reason: data.reason,
        projectId: data.projectId ?? null,
      });
      const saved = await txService.repo.save(record);
      createdId = saved.id;

      // 2. 在同一事务内提交审批
      const submitter = await txService.userRepo.findOneBy({ id: data.userId });
      const resolved = await txService.approvalInstanceService.start({
        targetType: 'overtime',
        targetId: saved.id,
        applicantId: data.userId,
        projectId: saved.projectId,
      });
      Object.assign(saved, orgSnapshot);
      if (resolved.status === 'submitted' && resolved.instance) {
        await txService.repo.update(saved.id, {
          status: 'submitted',
          currentStep: resolved.instance.currentStepOrder || 1,
          approvalFlowId: resolved.instance.flowId,
          approvalInstanceId: resolved.instance.id,
          totalSteps: resolved.instance.totalSteps,
        });
        if (submitter && resolved.firstApproverIds.length) {
          notifications.push({
            approverIds: resolved.firstApproverIds,
            targetType: 'overtime',
            targetId: saved.id,
            applicantName: submitter.realName,
            title: `加班审批 ${saved.days}天`,
          });
        }
      } else {
        await txService.repo.update(saved.id, {
          status: 'approved',
          currentStep: 0,
          totalSteps: 0,
          approvalInstanceId: resolved.instance?.id ?? null,
        });
      }
    });

    // 事务提交后发通知（失败不影响业务）
    const notifier = new NotificationPublisher();
    for (const n of notifications) {
      try { await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title); } catch {}
    }

    return this.repo.findOne({
      where: { id: createdId! },
      relations: ['project'],
    });
  }

  async update(id: number, userId: number, data: { date?: string; overtimeType?: string; days?: number; reason?: string; projectId?: number }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能修改自己的加班记录');
    if (!['draft', 'rejected', 'withdrawn'].includes(record.status)) {
      throw new BusinessError('审批中或已通过的加班记录不可修改');
    }

    if (data.projectId !== undefined) await this.ensureActiveProject(data.projectId);

    if (data.date !== undefined) record.date = data.date;
    if (data.overtimeType !== undefined) record.overtimeType = data.overtimeType as OvertimeType;
    if (data.days !== undefined) record.days = data.days;
    if (data.reason !== undefined) record.reason = data.reason;
    if (data.projectId !== undefined) record.projectId = data.projectId ?? null;
    if (record.status === 'rejected' || record.status === 'withdrawn') {
      record.status = 'draft';
      record.currentStep = 0;
      record.approvalFlowId = null;
      record.approvalInstanceId = null;
      record.totalSteps = 0;
    }
    return this.repo.save(record);
  }

  async delete(id: number, userId: number) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能删除自己的加班记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可删除');

    return this.repo.delete(id);
  }

  async getByUser(userId: number, params: { startDate?: string; endDate?: string; status?: string; page?: number; pageSize?: number }) {
    const { startDate, endDate, status, page = 1, pageSize = 20 } = params;
    const qb = this.repo.createQueryBuilder('o')
      .leftJoinAndSelect('o.project', 'project')
      .where('o.userId = :userId', { userId });

    if (startDate) qb.andWhere('o.date >= :startDate', { startDate });
    if (endDate) qb.andWhere('o.date <= :endDate', { endDate });
    if (status) {
      qb.andWhere('o.status = :status', { status });
    }

    qb.orderBy('o.date', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    return { list, total, page, pageSize };
  }

  /** 提交审批 — 解析审批流程（事务化，通知外置） */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new BusinessError('请选择要提交的记录');

    type PendingNotify = { approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string };
    const notifications: PendingNotify[] = [];

    await this.transaction(async (manager) => {
      const txService = new OvertimeService(manager);
      const uniqueIds = [...new Set(ids)];
      const records = await txService.repo.findBy({ id: In(uniqueIds) });
      if (records.length !== uniqueIds.length) throw new BusinessError('部分加班记录不存在，请刷新列表后重试');
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);
      for (const r of records) {
        if (r.userId !== userId) throw new BusinessError('只能提交自己的加班记录');
        if (r.status !== 'draft') throw new BusinessError(`记录 ${r.id} 不是草稿状态，无法提交`);
        Object.assign(r, orgSnapshot);
      }
      await txService.repo.save(records);

      const submitter = await txService.userRepo.findOneBy({ id: userId });
      for (const r of records) {
        const resolved = await txService.approvalInstanceService.start({
          targetType: 'overtime',
          targetId: r.id,
          applicantId: userId,
          projectId: r.projectId,
        });
        if (resolved.status === 'submitted' && resolved.instance) {
          await txService.repo.update(r.id, {
            status: 'submitted',
            currentStep: resolved.instance.currentStepOrder || 1,
            approvalFlowId: resolved.instance.flowId,
            approvalInstanceId: resolved.instance.id,
            totalSteps: resolved.instance.totalSteps,
          });
          if (submitter && resolved.firstApproverIds.length) {
            notifications.push({
              approverIds: resolved.firstApproverIds,
              targetType: 'overtime',
              targetId: r.id,
              applicantName: submitter.realName,
              title: `加班审批 ${r.days}天`,
            });
          }
        } else {
          await txService.repo.update(r.id, {
            status: 'approved',
            currentStep: 0,
            totalSteps: 0,
            approvalInstanceId: resolved.instance?.id ?? null,
          });
        }
      }
    });

    const notifier = new NotificationPublisher();
    for (const n of notifications) {
      try { await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title); } catch {}
    }
    return true;
  }

  async getStats(userId: number, year: number, month?: number) {
    const { startDate, endDate } = getOvertimeStatsDateRange(year, month);
    const qb = this.repo.createQueryBuilder('o')
      .select('o.overtimeType', 'type')
      .addSelect('SUM(o.days)', 'totalDays')
      .addSelect('COUNT(o.id)', 'count')
      .where('o.userId = :userId', { userId })
      .andWhere('o.status = :status', { status: 'approved' })
      .andWhere('o.date >= :startDate AND o.date < :endDate', { startDate, endDate });

    qb.groupBy('o.overtimeType');
    return qb.getRawMany();
  }
}
