import { AppDataSource } from '../config/database';
import { OvertimeApplication, OvertimeType } from '../entities/OvertimeApplication';
import { Between, In } from 'typeorm';
import { ApprovalInstanceService } from './approvalInstanceService';
import { NotificationService } from './notificationService';
import { User } from '../entities/User';
import { AccessPolicyService } from './accessPolicyService';

export class OvertimeService {
  private repo = AppDataSource.getRepository(OvertimeApplication);
  private approvalInstanceService = new ApprovalInstanceService();
  private notificationService = new NotificationService();
  private accessPolicy = new AccessPolicyService();
  private userRepo = AppDataSource.getRepository(User);

  async create(data: { userId: number; date?: string; overtimeType?: string; hours?: number; reason?: string; projectId?: number }) {
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.repo.create({
      userId: data.userId,
      ...orgSnapshot,
      date: data.date!,
      overtimeType: data.overtimeType as OvertimeType,
      hours: data.hours!,
      reason: data.reason,
      projectId: data.projectId ?? null,
    });
    return this.repo.save(record);
  }

  async createAndSubmit(data: { userId: number; date?: string; overtimeType?: string; hours?: number; reason?: string; projectId?: number }) {
    const record = await this.create(data);
    try {
      await this.submit([record.id], data.userId);
    } catch (error) {
      const latest = await this.repo.findOne({ where: { id: record.id } });
      if (latest?.status === 'draft') {
        await this.repo.delete(record.id);
      }
      throw error;
    }

    return this.repo.findOne({
      where: { id: record.id },
      relations: ['project'],
    });
  }

  async update(id: number, userId: number, data: { date?: string; overtimeType?: string; hours?: number; reason?: string; projectId?: number }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new Error('记录不存在');
    if (record.userId !== userId) throw new Error('只能修改自己的加班记录');
    if (record.status !== 'draft') throw new Error('仅草稿状态可修改');

    if (data.date !== undefined) record.date = data.date;
    if (data.overtimeType !== undefined) record.overtimeType = data.overtimeType as OvertimeType;
    if (data.hours !== undefined) record.hours = data.hours;
    if (data.reason !== undefined) record.reason = data.reason;
    if (data.projectId !== undefined) record.projectId = data.projectId ?? null;
    return this.repo.save(record);
  }

  async delete(id: number, userId: number) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new Error('记录不存在');
    if (record.userId !== userId) throw new Error('只能删除自己的加班记录');
    if (record.status !== 'draft') throw new Error('仅草稿状态可删除');

    return this.repo.delete(id);
  }

  async getByUser(userId: number, params: { startDate?: string; endDate?: string; status?: string; page?: number; pageSize?: number }) {
    const { startDate, endDate, status, page = 1, pageSize = 20 } = params;
    const qb = this.repo.createQueryBuilder('o')
      .leftJoinAndSelect('o.project', 'project')
      .where('o.userId = :userId', { userId });

    if (startDate && endDate) {
      qb.andWhere('o.date BETWEEN :startDate AND :endDate', { startDate, endDate });
    }
    if (status) {
      qb.andWhere('o.status = :status', { status });
    }

    qb.orderBy('o.date', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    return { list, total, page, pageSize };
  }

  /** 提交审批 — 解析审批流程 */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new Error('请选择要提交的记录');
    const records = await this.repo.findBy({ id: In(ids) });
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(userId);
    for (const r of records) {
      if (r.userId !== userId) throw new Error('只能提交自己的加班记录');
      if (r.status !== 'draft') throw new Error(`记录 ${r.id} 不是草稿状态，无法提交`);
      Object.assign(r, orgSnapshot);
    }
    await this.repo.save(records);

    const submitter = await this.userRepo.findOneBy({ id: userId });
    for (const r of records) {
      const resolved = await this.approvalInstanceService.start({
        targetType: 'overtime',
        targetId: r.id,
        applicantId: userId,
        projectId: r.projectId,
      });
      if (resolved.status === 'submitted' && resolved.instance) {
        await this.repo.update(r.id, {
          status: 'submitted',
          currentStep: resolved.instance.currentStepOrder || 1,
          approvalFlowId: resolved.instance.flowId,
          approvalInstanceId: resolved.instance.id,
          totalSteps: resolved.instance.totalSteps,
        });
        if (submitter && resolved.firstApproverIds.length) {
          await this.notificationService.notifyApprovalPending(
            resolved.firstApproverIds,
            'overtime',
            r.id,
            submitter.realName,
            `加班审批 ${r.hours}小时`,
          );
        }
      } else {
        await this.repo.update(r.id, {
          status: 'approved',
          currentStep: 0,
          totalSteps: 0,
          approvalInstanceId: resolved.instance?.id ?? null,
        });
      }
    }
    return true;
  }

  async getStats(userId: number, year: number, month?: number) {
    const qb = this.repo.createQueryBuilder('o')
      .select('o.overtimeType', 'type')
      .addSelect('SUM(o.hours)', 'totalHours')
      .addSelect('COUNT(o.id)', 'count')
      .where('o.userId = :userId AND o.status = :status', { userId, status: 'approved' });

    if (month) {
      qb.andWhere("strftime('%Y', o.date) = :year AND strftime('%m', o.date) = :month", {
        year: String(year), month: String(month).padStart(2, '0'),
      });
    } else {
      qb.andWhere("strftime('%Y', o.date) = :year", { year: String(year) });
    }

    qb.groupBy('o.overtimeType');
    return qb.getRawMany();
  }
}
