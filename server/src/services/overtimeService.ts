import { EntityManager } from 'typeorm';
import dayjs from 'dayjs';
import { BusinessError, isUniqueViolation } from '../utils/errors';
import { AppDataSource } from '../config/database';
import { OvertimeApplication, OvertimeType } from '../entities/OvertimeApplication';
import { Between, In } from 'typeorm';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationPublisher } from './notifications';
import { User } from '../entities/User';
import { AccessPolicyService } from './accessPolicyService';
import { Project } from '../entities/Project';
import { HolidayService } from './holidayService';
import { round2 } from '../utils/validation';

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

  /** 校验加班字段：不晚于今天、范围 (0,1] 天、0.5 步长（与前端 InputNumber 一致）。 */
  private assertOvertimeFields(date: string, days: number) {
    const today = dayjs().format('YYYY-MM-DD');
    if (date > today) throw new BusinessError('加班日期不能晚于今天');
    if (!Number.isFinite(days) || days <= 0 || days > 1) {
      throw new BusinessError('加班天数应在 (0, 1] 天之间');
    }
    if (Math.abs(days / 0.5 - Math.round(days / 0.5)) > 1e-9) {
      throw new BusinessError('加班天数必须是 0.5 的整数倍');
    }
  }

  /** 校验同一日期加班合计 ≤ 1 天（含 draft/submitted/approved）；excludeId 用于编辑/提交场景排除自身。 */
  private async assertOvertimeQuota(userId: number, date: string, days: number, excludeId?: number) {
    const qb = this.repo.createQueryBuilder('o')
      .select('COALESCE(SUM(o.days),0)', 'sum')
      .where('o.userId = :userId', { userId })
      .andWhere('o.date = :date', { date })
      .andWhere("o.status IN ('draft','submitted','approved')");
    if (excludeId) qb.andWhere('o.id != :excludeId', { excludeId });
    const row = await qb.getRawOne<{ sum: string | number }>();
    const used = Number(row?.sum ?? 0);
    if (used + days > 1 + 1e-9) {
      throw new BusinessError(`同一日期加班合计不能超过 1 天（已填报 ${round2(used)} 天）`);
    }
  }

  async create(data: { userId: number; date?: string; overtimeType?: string; days?: number; reason?: string; projectId?: number }) {
    await this.ensureActiveProject(data.projectId);
    this.assertOvertimeFields(data.date!, data.days!);
    await this.assertOvertimeQuota(data.userId, data.date!, data.days!);
    // 加班类型由服务端按节假日日历+周末权威判定，覆盖客户端传入值（杜绝把工作日标成节假日等失真分类）。
    const overtimeType = await new HolidayService(this.manager).inferOvertimeType(data.date!);
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.repo.create({
      userId: data.userId,
      ...orgSnapshot,
      date: data.date!,
      overtimeType,
      days: data.days!,
      reason: data.reason,
      projectId: data.projectId ?? null,
    });
    try {
      return await this.repo.save(record);
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessError('该日期已存在同类型的加班记录');
      throw err;
    }
  }

  async createAndSubmit(data: { userId: number; date?: string; overtimeType?: string; days?: number; reason?: string; projectId?: number }) {
    // 整体事务：create + submit 原子化，任一失败整体回滚，避免孤儿记录或误删
    const notifications: { approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string }[] = [];
    let createdId: number;

    await this.transaction(async (manager) => {
      const txService = new OvertimeService(manager);
      await txService.ensureActiveProject(data.projectId);
      txService.assertOvertimeFields(data.date!, data.days!);
      await txService.assertOvertimeQuota(data.userId, data.date!, data.days!);
      // 加班类型由服务端权威判定，覆盖客户端值（与 create/update 一致）。
      const overtimeType = await new HolidayService(manager).inferOvertimeType(data.date!);
      // 1. 创建草稿
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(data.userId);
      const record = txService.repo.create({
        userId: data.userId,
        ...orgSnapshot,
        date: data.date!,
        overtimeType,
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
    // 加班类型由服务端按（可能更新后的）日期重新推断，覆盖客户端值。
    record.overtimeType = await new HolidayService(this.manager).inferOvertimeType(record.date);
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
    this.assertOvertimeFields(record.date, record.days);
    await this.assertOvertimeQuota(userId, record.date, record.days, id);
    try {
      return await this.repo.save(record);
    } catch (err) {
      if (isUniqueViolation(err)) throw new BusinessError('该日期已存在同类型的加班记录');
      throw err;
    }
  }

  /** 编辑后原子地重新提交审批（update + submit 单事务，避免“update 成功但 submit 失败”的中间态残留）。 */
  async updateAndSubmit(id: number, userId: number, data: { date?: string; overtimeType?: string; days?: number; reason?: string; projectId?: number }) {
    type PendingNotify = { approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string };
    const notifications: PendingNotify[] = [];
    let updatedId!: number;

    await this.transaction(async (manager) => {
      const txService = new OvertimeService(manager);
      const record = await txService.repo.findOne({ where: { id } });
      if (!record) throw new BusinessError('记录不存在');
      if (record.userId !== userId) throw new BusinessError('只能修改自己的加班记录');
      if (!['draft', 'rejected', 'withdrawn'].includes(record.status)) {
        throw new BusinessError('审批中或已通过的加班记录不可修改');
      }
      if (data.projectId !== undefined) await txService.ensureActiveProject(data.projectId);
      if (data.date !== undefined) record.date = data.date;
      // 加班类型由服务端按（可能更新后的）日期重新推断，覆盖客户端值。
      record.overtimeType = await new HolidayService(manager).inferOvertimeType(record.date);
      if (data.days !== undefined) record.days = data.days;
      if (data.reason !== undefined) record.reason = data.reason;
      if (data.projectId !== undefined) record.projectId = data.projectId ?? null;
      // 重置审批相关字段（rejected/withdrawn → 重新提交）
      record.status = 'draft';
      record.currentStep = 0;
      record.approvalFlowId = null;
      record.approvalInstanceId = null;
      record.totalSteps = 0;
      txService.assertOvertimeFields(record.date, record.days);
      await txService.assertOvertimeQuota(userId, record.date, record.days, id);
      const saved = await txService.repo.save(record);
      updatedId = saved.id;

      const submitter = await txService.userRepo.findOneBy({ id: userId });
      const resolved = await txService.approvalInstanceService.start({
        targetType: 'overtime',
        targetId: saved.id,
        applicantId: userId,
        projectId: saved.projectId,
      });
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
            approverIds: resolved.firstApproverIds, targetType: 'overtime', targetId: saved.id,
            applicantName: submitter.realName, title: `加班审批 ${saved.days}天`,
          });
        }
      } else {
        await txService.repo.update(saved.id, {
          status: 'approved', currentStep: 0, totalSteps: 0, approvalInstanceId: resolved.instance?.id ?? null,
        });
      }
    }).catch((err) => {
      if (isUniqueViolation(err)) throw new BusinessError('该日期已存在同类型的加班记录');
      throw err;
    });

    // 事务提交后发通知（失败不影响业务）
    const notifier = new NotificationPublisher();
    for (const n of notifications) {
      try { await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title); } catch {}
    }
    return this.repo.findOne({ where: { id: updatedId }, relations: ['project'] });
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
        txService.assertOvertimeFields(r.date, r.days);
        Object.assign(r, orgSnapshot);
      }
      // 同日合计把关（排除自身，防止绕过 create 校验累积超额）
      for (const r of records) {
        await txService.assertOvertimeQuota(userId, r.date, r.days, r.id);
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
    }).catch((err) => {
      // 并发提交撞 approval_instances 的 (targetType,targetId) 活跃唯一索引 → 友好提示
      if (isUniqueViolation(err)) throw new BusinessError('该加班记录已提交，请刷新后重试');
      throw err;
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
