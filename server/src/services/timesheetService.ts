import { EntityManager } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { SystemSetting } from '../entities/SystemSetting';
import { SubmissionSequence } from '../entities/SubmissionSequence';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { ApprovalInstance } from '../entities/ApprovalInstance';
import { Between, In, Not, Brackets } from 'typeorm';
import { NotificationService } from './notificationService';
import { User } from '../entities/User';
import { ApprovalInstanceService } from './approvalInstanceService';
import { AccessPolicyService, OrgSnapshot } from './accessPolicyService';
import { BusinessError } from '../utils/errors';
import { round2 } from '../utils/validation';
import { logger } from '../utils/logger';
import { CacheKeys, CacheTtl, cacheGet, cacheSet } from '../config/cache';
import {
  enqueueTimesheetApprovals,
  type TimesheetApprovalJob,
} from './approvalQueue';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);

function dayjsExt(d: string | dayjs.Dayjs) { return dayjs(d); }

/**
 * 按「项目+日期」维度去重：同一 (projectId, date) 只保留 submissionGroupId 最大（最新版本）的记录。
 * 排除 deprecated/rejected/withdrawn 状态。
 *
 * 说明：submitByRows 提交时每个 projectId 独立分配一个 submissionGroupId，因此同一天多个项目
 * 会有多个不同 submissionGroupId。去重必须按 (projectId, date) 取各自最新版本，否则会丢失
 * 同一天的其他项目（仅保留 submissionGroupId 最大的那一个项目）。
 * 入参 records 应已是单用户范围。
 */
export function dedupByLatestSubmissionGroup(records: Timesheet[]): Timesheet[] {
  // 找出每个 (projectId, date) 对应的最大 submissionGroupId
  const maxGroupByKey = new Map<string, number>();
  for (const r of records) {
    if (r.status === 'deprecated' || r.status === 'rejected' || r.status === 'withdrawn') continue;
    if (!r.submissionGroupId) continue;
    const key = `${r.projectId}_${r.date}`;
    const cur = maxGroupByKey.get(key);
    if (cur === undefined || r.submissionGroupId > cur) {
      maxGroupByKey.set(key, r.submissionGroupId);
    }
  }
  // 只保留属于该 (projectId, date) 最大 submissionGroupId 的记录
  return records.filter(r =>
    r.status !== 'deprecated' && r.status !== 'rejected' && r.status !== 'withdrawn'
    && r.submissionGroupId === maxGroupByKey.get(`${r.projectId}_${r.date}`)
  );
}

/** 通知动作（事务提交后统一发送，避免长事务 & 通知失败不回滚业务） */
type PendingNotification =
  | { kind: 'pending'; approverIds: number[]; targetType: string; targetId: number; applicantName: string; title: string }
  | { kind: 'result'; applicantId: number; targetType: string; targetId: number; approved: boolean; comment?: string };

export class TimesheetService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(Timesheet); }
  private get recordRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalRecord); }
  private get instanceRepo() { return (this.manager ?? AppDataSource).getRepository(ApprovalInstance); }
  private get approvalInstanceService() { return new ApprovalInstanceService(this.manager); }
  private get accessPolicy() { return new AccessPolicyService(this.manager); }
  private get userRepo() { return (this.manager ?? AppDataSource).getRepository(User); }
  private get settingRepo() { return (this.manager ?? AppDataSource).getRepository(SystemSetting); }
  private get seqRepo() { return (this.manager ?? AppDataSource).getRepository(SubmissionSequence); }

  private createRecord(data: Partial<Timesheet> & { userId: number }, orgSnapshot: OrgSnapshot) {
    return this.repo.create({ ...data, ...orgSnapshot });
  }

  /** 读系统设置（Redis 缓存，未命中回落 DB） */
  private async getSettingValue(settingKey: string): Promise<string | null> {
    const cacheKey = CacheKeys.setting(settingKey);
    const cached = await cacheGet<{ value: string | null }>(cacheKey);
    if (cached) return cached.value;

    const row = await this.settingRepo.findOne({ where: { key: settingKey } });
    const value = row?.value ?? null;
    await cacheSet(cacheKey, { value }, CacheTtl.setting);
    return value;
  }

  /** 检查工时锁定 */
  private async checkTimesheetLock(dates: string[]) {
    const raw = await this.getSettingValue('timesheet_lock_day');
    if (!raw) return;
    const lockDay = parseInt(raw, 10);
    if (isNaN(lockDay) || lockDay < 1 || lockDay > 28) return;
    const now = dayjs();
    const currentMonthStart = now.startOf('month');
    const previousMonthStart = currentMonthStart.subtract(1, 'month');
    for (const date of dates) {
      const d = dayjs(date);
      const isOlderThanPreviousMonth = d.isBefore(previousMonthStart, 'day');
      const isPreviousMonthAfterLockDay = d.isBefore(currentMonthStart, 'day') && now.date() > lockDay;
      if (isOlderThanPreviousMonth || isPreviousMonthAfterLockDay) {
        throw new BusinessError(`${date} 是上月的工时，每月${lockDay}号后不允许提交上月工时`);
      }
    }
  }

  /** 合法的工时填报单位（天步长）与默认值，须与前端/路由保持一致 */
  private static readonly UNIT_OPTIONS = [0.1, 0.2, 0.25, 0.5];
  private static readonly DEFAULT_UNIT = 0.5;

  /** 读取工时填报单位步长（天）；缺失/非法返回默认 0.5 */
  private async loadUnitStep(): Promise<number> {
    const raw = await this.getSettingValue('timesheet_unit');
    const n = Number(raw);
    return TimesheetService.UNIT_OPTIONS.includes(n) ? n : TimesheetService.DEFAULT_UNIT;
  }

  /** 校验单日工时合计不超过1天（天步长语义，带浮点容差） */
  private validateDailyDays(dailyDays: Record<string, number>) {
    for (const [date, total] of Object.entries(dailyDays)) {
      if (total > 1 + 1e-9) {
        throw new BusinessError(`${date} 工时合计 ${total.toFixed(2)} 天，超过每日1天上限`);
      }
    }
  }

  /** 校验每个 days 值是步长的整数倍（带浮点容差） */
  private validateStepMultiple(entries: { date: string; days: number }[], step: number, field: string) {
    for (const e of entries) {
      if (e.days <= 0) continue;
      const ratio = e.days / step;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        throw new BusinessError(`${field}：${e.date} 工时 ${e.days} 不是填报单位 ${step} 天的整数倍`);
      }
    }
  }


  async create(data: { userId: number; projectId: number; date: string; days: number; description?: string }) {
    // 草稿创建也校验步长倍数，防止非步长值落库（每日上限留待提交时校验，草稿可跨日累积）
    const step = await this.loadUnitStep();
    this.validateStepMultiple([{ date: data.date, days: data.days }], step, '工时');
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(data.userId);
    const record = this.createRecord(data, orgSnapshot);
    return this.repo.save(record);
  }

  async batchCreate(userId: number, items: { projectId: number; date: string; days: number; description?: string }[]) {
    const step = await this.loadUnitStep();
    items.forEach((item, i) => this.validateStepMultiple([{ date: item.date, days: item.days }], step, `items[${i}]`));
    const orgSnapshot = await this.accessPolicy.getOrgSnapshot(userId);
    const records = items.map(item => this.createRecord({ ...item, userId }, orgSnapshot));
    return this.repo.save(records);
  }

  async update(id: number, userId: number, data: { projectId?: number; days?: number; description?: string }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能修改自己的工时记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可修改');
    // 若更新了 days，校验步长倍数
    if (data.days !== undefined) {
      const step = await this.loadUnitStep();
      this.validateStepMultiple([{ date: record.date, days: data.days }], step, '工时');
    }
    Object.assign(record, data);
    return this.repo.save(record);
  }

  async delete(id: number, userId: number) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new BusinessError('记录不存在');
    if (record.userId !== userId) throw new BusinessError('只能删除自己的工时记录');
    if (record.status !== 'draft') throw new BusinessError('仅草稿状态可删除');
    return this.repo.delete(id);
  }

  /** 查询用户工时列表 */
  async getByUser(userId: number, params: { startDate?: string; endDate?: string; status?: string; page?: number; pageSize?: number; includeAll?: boolean }) {
    const { startDate, endDate, status, page = 1, pageSize = 50, includeAll } = params;
    const qb = this.repo.createQueryBuilder('t')
      .leftJoinAndSelect('t.project', 'p')
      .where('t.userId = :userId', { userId });

    if (!includeAll) {
      // 周填报表查询：并集返回「已提交的最新版本」+「真草稿(draft)」。
      //
      // 路径A（已分组最新版本）：submitByRows 每个 projectId 独立分配 submissionGroupId，
      //   故按 (projectId, date) 取 MAX(submissionGroupId) 得到各项目最新提交版本。
      // 路径B（真草稿）：draft 的 submissionGroupId 本就是 null（未提交），单独查 status='draft'。
      //   撤回记录(status=withdrawn, group 保留)被两路都排除：路径A按 status 排除 withdrawn，
      //   路径B要求 status=draft。故撤回记录不显示（仅历史记录可见）。
      const maxGroupQb = this.repo.createQueryBuilder('d')
        .select('MAX(d.submissionGroupId)', 'maxGroup')
        .where('d.userId = :uid', { uid: userId })
        .andWhere('d.status NOT IN (:...excl)', { excl: ['deprecated', 'rejected', 'withdrawn'] })
        .andWhere('d.submissionGroupId IS NOT NULL')
        .groupBy('d.projectId, d.date');
      if (startDate && endDate) {
        maxGroupQb.andWhere('d.date BETWEEN :ds AND :de', { ds: startDate, de: endDate });
      }
      if (status) {
        maxGroupQb.andWhere('d.status = :st', { st: status });
      }
      const maxGroupRows = await maxGroupQb.getRawMany<{ maxGroup: number }>();
      const maxGroups = maxGroupRows.map(r => r.maxGroup).filter(Boolean);

      if (startDate && endDate) {
        qb.andWhere('t.date BETWEEN :ds AND :de', { ds: startDate, de: endDate });
      }
      // 并集：已提交最新版本(路径A) 或 真草稿(路径B)
      qb.andWhere(new Brackets(qb1 => {
        // 路径A：maxGroups 非空时取这些 group 的非终态记录
        if (maxGroups.length > 0) {
          qb1.where('t.submissionGroupId IN (:...maxGroups)', { maxGroups })
            .andWhere('t.status NOT IN (:...mainExcl)', { mainExcl: ['deprecated', 'rejected', 'withdrawn'] })
            .orWhere('t.submissionGroupId IS NULL AND t.status = :draft', { draft: 'draft' });
        } else {
          // 无已提交版本：只查真草稿
          qb1.where('t.submissionGroupId IS NULL AND t.status = :draft', { draft: 'draft' });
        }
      }));
      if (status) {
        qb.andWhere('t.status = :status', { status });
      }
    } else {
      // includeAll（历史记录）：按提交时间筛选，而非工时日期。
      // 这样跨周/跨月的提交记录能整组完整返回（一组工时共享同一个 submissionGroupId），
      // 只要提交时间落在筛选范围内，整组都显示。
      if (startDate && endDate) qb.andWhere('t.updatedAt BETWEEN :startDate AND :endDate', { startDate, endDate });
      if (status) qb.andWhere('t.status = :status', { status });
    }

    qb.orderBy('t.date', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();
    return { list, total, page, pageSize };
  }

  /** 按日期范围查询 — 按 date 取最大 submissionGroupId（最新版本），排除废弃/驳回/撤回 */
  async getByDateRange(userId: number, startDate: string, endDate: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(startDate, endDate), status: Not('deprecated') },
      relations: ['project'],
      order: { date: 'ASC' },
    });
    const records = dedupByLatestSubmissionGroup(rawRecords);
    return records.sort((a, b) => a.date.localeCompare(b.date));
  }
  /** 在事务内原子地分配下一个 submissionGroupId（优先 Redis INCR，失败回退 DB 行锁） */
  private async nextSubmissionGroupId(): Promise<number> {
    const ids = await this.nextSubmissionGroupIds(1);
    return ids[0];
  }

  /** 一次分配 count 个连续序号，减少多项目提交往返 */
  private async nextSubmissionGroupIds(count: number): Promise<number[]> {
    if (count <= 0) return [];
    const { redisNextSubmissionGroupIds } = await import('../config/redis');
    const fromRedis = await redisNextSubmissionGroupIds(count);
    if (fromRedis) return fromRedis;

    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const existing = await this.seqRepo.findOneBy({ id: 1 });
      if (!existing) {
        const maxGroup = await this.repo.createQueryBuilder('t')
          .select('MAX(t.submissionGroupId)', 'maxId')
          .getRawOne<{ maxId: number | null }>();
        const nextId = (maxGroup?.maxId ?? 0) + 1;
        await this.seqRepo.save(this.seqRepo.create({ id: 1, currentValue: nextId }));
        out.push(nextId);
        continue;
      }
      await this.seqRepo.increment({ id: 1 }, 'currentValue', 1);
      const updated = await this.seqRepo.findOneBy({ id: 1 });
      out.push(updated!.currentValue);
    }
    return out;
  }

  /**
   * 事务提交后创建审批实例并回写工时状态。
   * - SUBMIT_APPROVAL_SYNC=1：同步执行（测试）
   * - 否则优先入 Redis 队列由 worker 消费；入队失败则 setImmediate 降级
   */
  private scheduleTimesheetApprovals(jobs: TimesheetApprovalJob[]): Promise<void> | void {
    if (!jobs.length) return;
    if (process.env.SUBMIT_APPROVAL_SYNC === '1') {
      return this.processApprovalJobs(jobs).catch((err) => {
        logger.error({ err, jobs: jobs.map((j) => j.targetId) }, '[timesheet] 后置审批失败');
      });
    }
    return enqueueTimesheetApprovals(jobs).then((ok) => {
      if (ok) return;
      setImmediate(() => {
        this.processApprovalJobs(jobs).catch((err) => {
          logger.error({ err, jobs: jobs.map((j) => j.targetId) }, '[timesheet] 后置审批降级失败');
        });
      });
    });
  }

  /** 供队列 worker / 同步路径调用（支持批量 start） */
  async processApprovalJobs(jobs: TimesheetApprovalJob[]) {
    if (!jobs.length) return;
    const notifications: PendingNotification[] = [];
    const svc = new TimesheetService();
    const submitterCache = new Map<number, User | null>();

    const heads = await svc.repo.findBy({ id: In(jobs.map((j) => j.targetId)) });
    const headById = new Map(heads.map((h) => [h.id, h]));

    const activeJobs: TimesheetApprovalJob[] = [];
    for (const job of jobs) {
      const head = headById.get(job.targetId);
      if (!head || head.status === 'deprecated' || head.status === 'withdrawn') {
        logger.info({ targetId: job.targetId, status: head?.status }, '[timesheet] 跳过过期审批任务');
        continue;
      }
      activeJobs.push(job);
    }
    if (!activeJobs.length) return;

    // Streams 是至少一次投递：先复用已经创建的实例，避免 worker 在实例落库后、ACK 前
    // 崩溃时重复创建。数据库唯一索引负责兜住多实例同时首次处理的竞态。
    const existingInstances = await svc.instanceRepo.find({
      where: {
        targetType: 'timesheet',
        targetId: In(activeJobs.map((job) => job.targetId)),
      },
    });
    const existingByTarget = new Map(existingInstances.map((instance) => [instance.targetId, instance]));
    const newJobs = activeJobs.filter((job) => !existingByTarget.has(job.targetId));
    const createdList = await svc.approvalInstanceService.startMany(
      newJobs.map((job) => ({
        targetType: 'timesheet' as const,
        targetId: job.targetId,
        applicantId: job.userId,
        projectId: job.projectId,
      })),
    );
    const resolvedByTarget = new Map<number, {
      status: 'approved' | 'submitted';
      instance: ApprovalInstance;
      firstApproverIds: number[];
    }>();
    newJobs.forEach((job, index) => resolvedByTarget.set(job.targetId, createdList[index]));
    for (const instance of existingInstances) {
      const firstStep = instance.stepsSnapshot?.find((step) => step.stepOrder === 1);
      resolvedByTarget.set(instance.targetId, {
        status: instance.status === 'approved' ? 'approved' : 'submitted',
        instance,
        firstApproverIds: firstStep?.approvers.map((approver) => approver.id) ?? [],
      });
    }

    // 按结果分组批量回写工时（同一批内 instance 字段不同，仍逐条 update；减少 find）
    for (let i = 0; i < activeJobs.length; i++) {
      const job = activeJobs[i];
      const resolved = resolvedByTarget.get(job.targetId)!;
      if (resolved.status === 'submitted' && resolved.instance) {
        await svc.repo.update(
          { id: In(job.recordIds), status: 'submitted' },
          {
            status: 'submitted',
            currentStep: resolved.instance.currentStepOrder || 1,
            approvalFlowId: resolved.instance.flowId,
            approvalInstanceId: resolved.instance.id,
            totalSteps: resolved.instance.totalSteps,
          },
        );
        if (resolved.firstApproverIds.length) {
          let submitter = submitterCache.get(job.userId);
          if (submitter === undefined) {
            submitter = await svc.userRepo.findOneBy({ id: job.userId });
            submitterCache.set(job.userId, submitter);
          }
          if (submitter) {
            notifications.push({
              kind: 'pending',
              approverIds: resolved.firstApproverIds,
              targetType: 'timesheet',
              targetId: job.targetId,
              applicantName: submitter.realName,
              title: job.title,
            });
          }
        }
      } else {
        await svc.repo.update(
          { id: In(job.recordIds), status: 'submitted' },
          {
            status: 'approved',
            currentStep: 0,
            totalSteps: 0,
            approvalInstanceId: resolved.instance?.id ?? null,
          },
        );
      }
    }
    await svc.flushNotifications(notifications);
  }

  /** 提交审批 */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new BusinessError('请选择要提交的记录');

    // 预读工时填报单位（天步长），供校验
    const unitStep = await this.loadUnitStep();
    const approvalJobs: TimesheetApprovalJob[] = [];

    // 锁检查移出事务，缩短写事务持锁时间
    const preview = await this.repo.findBy({ id: In(ids) });
    await this.checkTimesheetLock(preview.map((r) => r.date));

    await AppDataSource.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const records = await txService.repo.findBy({ id: In(ids) });
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);
      for (const r of records) {
        if (r.userId !== userId) throw new BusinessError('只能提交自己的工时记录');
        if (r.status !== 'draft') throw new BusinessError(`记录 ${r.id} 不是草稿状态，无法提交`);
        Object.assign(r, orgSnapshot);
      }

      const entries = records.map(r => ({ date: r.date, days: Number(r.days) }));
      txService.validateStepMultiple(entries, unitStep, '记录');
      const dailyDays: Record<string, number> = {};
      for (const e of entries) dailyDays[e.date] = (dailyDays[e.date] || 0) + e.days;
      txService.validateDailyDays(dailyDays);

      // 批量 UPDATE，避免逐条 save
      const recordIds = records.map((r) => r.id);
      await txService.repo.update(
        { id: In(recordIds) },
        {
          status: 'submitted',
          currentStep: 0,
          totalSteps: 0,
          approvalFlowId: null,
          approvalInstanceId: null,
          ...orgSnapshot,
        },
      );

      for (const r of records) {
        approvalJobs.push({
          targetId: r.id,
          recordIds: [r.id],
          projectId: r.projectId,
          userId,
          title: `工时审批 ${r.days}天`,
        });
      }
    });

    const maybeWait = this.scheduleTimesheetApprovals(approvalJobs);
    if (maybeWait) await maybeWait;
    return true;
  }

  /**
   * 按行提交审批（事务化写工时；审批实例入 Redis 队列异步创建）
   */
  async submitByRows(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[]) {
    if (!rows?.length) throw new BusinessError('请选择要提交的记录');

    const allDates = rows.flatMap(r => r.entries.map(e => e.date));
    await this.checkTimesheetLock(allDates);

    // 读工时填报单位（天步长），校验每个工时值为步长整数倍
    const unitStep = await this.loadUnitStep();
    rows.forEach((row, i) => this.validateStepMultiple(row.entries, unitStep, `rows[${i}]`));

    const dailyDays: Record<string, number> = {};
    for (const row of rows) {
      for (const e of row.entries) {
        dailyDays[e.date] = (dailyDays[e.date] || 0) + e.days;
      }
    }
    this.validateDailyDays(dailyDays);

    const approvalJobs: TimesheetApprovalJob[] = [];

    await AppDataSource.transaction(async (manager) => {
      const txService = new TimesheetService(manager);
      const orgSnapshot = await txService.accessPolicy.getOrgSnapshot(userId);
      const submitter = await txService.userRepo.findOneBy({ id: userId });

      const weekStart = rows[0].weekStart;
      const weekEnd = dayjsExt(weekStart).add(6, 'day').format('YYYY-MM-DD');

      const existingRecords = await txService.repo.find({
        where: [
          { userId, date: Between(weekStart, weekEnd), status: 'draft' },
          { userId, date: Between(weekStart, weekEnd), status: 'rejected' },
          { userId, date: Between(weekStart, weekEnd), status: 'approved' },
          { userId, date: Between(weekStart, weekEnd), status: 'submitted' },
        ],
      });

      const recWithPrev = existingRecords.find(e => e.previousGroupId);
      const previousGroupId = recWithPrev?.previousGroupId || null;

      const projectDates = new Map<number, Set<string>>();
      const allEntryDates = new Set<string>();
      for (const row of rows) {
        const dates = new Set<string>();
        for (const e of row.entries) {
          if (e.days > 0) {
            dates.add(e.date);
            allEntryDates.add(e.date);
          }
        }
        projectDates.set(row.projectId, dates);
      }

      const removedIds = new Set<number>();
      const toRemoveIds: number[] = [];
      const toDeprecateIds: number[] = [];
      // 已撤回的 submissionGroupId 集合：避免循环内对同一 group 多行重复 withdraw
      const withdrawnGroupIds = new Set<number>();

      // 第一遍：分类清理，批量写库（替代逐条 save/remove）
      for (const rec of existingRecords) {
        const dates = projectDates.get(rec.projectId);
        const isInEntries = dates ? dates.has(rec.date) : allEntryDates.has(rec.date);

        if (rec.status === 'rejected') {
          if (!dates || (dates && !isInEntries)) {
            toRemoveIds.push(rec.id);
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'draft') {
          if (!dates || !isInEntries) {
            if (rec.submissionGroupId) {
              toDeprecateIds.push(rec.id);
            } else {
              toRemoveIds.push(rec.id);
            }
            removedIds.add(rec.id);
          }
        } else if (rec.status === 'approved' || rec.status === 'submitted') {
          // 被删项目立即 deprecate（见原注释：修改提交即生效）
          if (!dates) {
            toDeprecateIds.push(rec.id);
            removedIds.add(rec.id);
          }
        }
      }

      if (toDeprecateIds.length) {
        await txService.repo.update({ id: In(toDeprecateIds) }, { status: 'deprecated' });
      }
      if (toRemoveIds.length) {
        await txService.repo.delete(toRemoveIds);
      }

      type RowBuild = {
        projectId: number;
        description: string;
        records: Timesheet[];
        totalDays: number;
      };
      const builtRows: RowBuild[] = [];
      const deprecateInLoop: number[] = [];

      for (const row of rows) {
        if (!row.entries?.length) continue;

        const records: Timesheet[] = [];

        for (const entry of row.entries) {
          if (entry.days <= 0) continue;

          const existingRec = existingRecords.find(
            d => !removedIds.has(d.id) && d.date === entry.date && d.projectId === row.projectId
          );

          if (existingRec && existingRec.status === 'draft') {
            if (existingRec.submissionGroupId) {
              const oldSubGroupId = existingRec.submissionGroupId;
              deprecateInLoop.push(existingRec.id);
              removedIds.add(existingRec.id);
              records.push(txService.createRecord({
                userId,
                projectId: row.projectId,
                date: entry.date,
                days: entry.days,
                description: row.description,
                previousGroupId: oldSubGroupId,
              }, orgSnapshot));
            } else {
              Object.assign(existingRec, orgSnapshot);
              existingRec.days = entry.days;
              existingRec.description = row.description || existingRec.description;
              records.push(existingRec);
            }
          } else if (existingRec && (existingRec.status === 'rejected' || existingRec.status === 'approved' || existingRec.status === 'submitted')) {
            const oldSubGroupId = existingRec.submissionGroupId;
            if (existingRec.status === 'submitted') {
              const groupIdKey = existingRec.submissionGroupId ?? 0;
              if (groupIdKey && !withdrawnGroupIds.has(groupIdKey)) {
                withdrawnGroupIds.add(groupIdKey);
                // 审批实例可能尚在队列未创建：无 instanceId 则跳过 withdraw
                if (existingRec.approvalInstanceId && submitter) {
                  try {
                    await txService.approvalInstanceService.withdraw('timesheet', existingRec.id, userId, submitter.realName);
                    await txService.recordRepo.save(txService.recordRepo.create({
                      targetType: 'timesheet',
                      targetId: existingRec.id,
                      instanceId: existingRec.approvalInstanceId ?? null,
                      approverId: userId,
                      approverName: submitter.realName,
                      action: 'withdraw',
                      comment: '申请人修改工时，重新提交审批',
                      stepOrder: existingRec.currentStep || 1,
                      stepType: 'withdraw',
                      stepLabel: '撤回',
                    }));
                  } catch (err) {
                    // 队列竞态：实例刚结束或不存在时仍允许 deprecate 并重提
                    if (!(err instanceof BusinessError) || !String(err.message).includes('无法撤回')) {
                      throw err;
                    }
                  }
                }
              }
            }
            deprecateInLoop.push(existingRec.id);
            removedIds.add(existingRec.id);
            records.push(txService.createRecord({
              userId,
              projectId: row.projectId,
              date: entry.date,
              days: entry.days,
              description: row.description,
              previousGroupId: oldSubGroupId || previousGroupId,
            }, orgSnapshot));
          } else {
            records.push(txService.createRecord({
              userId,
              projectId: row.projectId,
              date: entry.date,
              days: entry.days,
              description: row.description,
              previousGroupId,
            }, orgSnapshot));
          }
        }

        if (records.length === 0) continue;
        builtRows.push({
          projectId: row.projectId,
          description: row.description,
          records,
          totalDays: round2(row.entries.reduce((s, e) => s + e.days, 0)),
        });
      }

      if (deprecateInLoop.length) {
        await txService.repo.update({ id: In(deprecateInLoop) }, { status: 'deprecated' });
      }

      // 一次分配全部 submissionGroupId
      const groupIds = await txService.nextSubmissionGroupIds(builtRows.length);
      const allToSave: Timesheet[] = [];

      for (let i = 0; i < builtRows.length; i++) {
        const built = builtRows[i];
        const nextGroupId = groupIds[i];
        const rowPrevGroup = existingRecords
          .filter(r => r.projectId === built.projectId && r.submissionGroupId
            && (r.status !== 'draft' || removedIds.has(r.id)))
          .sort((a, b) => b.id - a.id)[0];
        const inheritedRoot = rowPrevGroup?.rootGroupId || null;

        for (const r of built.records) {
          r.submissionGroupId = nextGroupId;
          r.previousGroupId = rowPrevGroup?.submissionGroupId || previousGroupId;
          r.rootGroupId = inheritedRoot || nextGroupId;
          r.status = 'submitted';
          r.currentStep = 0;
          r.totalSteps = 0;
          r.approvalFlowId = null;
          r.approvalInstanceId = null;
        }
        allToSave.push(...built.records);
      }

      if (allToSave.length) {
        await txService.repo.save(allToSave);
      }

      for (const built of builtRows) {
        approvalJobs.push({
          targetId: built.records[0].id,
          recordIds: built.records.map(r => r.id),
          projectId: built.projectId,
          userId,
          title: `工时审批 ${built.totalDays}天`,
        });
      }
    });

    const maybeWait = this.scheduleTimesheetApprovals(approvalJobs);
    if (maybeWait) await maybeWait;
    return true;
  }

  /**
   * 修改已提交/已审批的工时 —— 统一版本快照模型。
   *
   * 设计原则：任何对工时的改动（无论原状态是 draft / submitted / approved / rejected）
   * 都走同一条路径——旧版标记为 deprecated（保留审计历史，永不复活），
   * 改动落到新记录并自动发起新审批链。这与 submitByRows 完全同语义，
   * 因此直接委托。保留独立方法签名仅为前端路由兼容（POST /modify 与 /submit-rows 等价）。
   *
   * 这样消除了原先 modifySubmitted 把 approved 退回 draft 的反模式：
   * 审批通过即不可篡改，改动必须走新审批。
   */
  async modifySubmitted(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; days: number }[] }[]) {
    return this.submitByRows(userId, rows);
  }

  /** 事务提交后统一发送通知（失败不影响业务） */
  private async flushNotifications(notifications: PendingNotification[]) {
    const notifier = new NotificationService();
    for (const n of notifications) {
      try {
        if (n.kind === 'pending') {
          await notifier.notifyApprovalPending(n.approverIds, n.targetType, n.targetId, n.applicantName, n.title);
        } else {
          await notifier.notifyApprovalResult(n.applicantId, n.targetType, n.targetId, n.approved, n.comment);
        }
      } catch {}
    }
  }

  /**
   * 修改链查询：根据给定记录的 rootGroupId，一次性取回整条修改链
   * （原始提交 v1 → 修改 v2 → 修改 v3 …，含已 deprecated 的历史版本）。
   * 按 submissionGroupId 分组返回，组内按日期排序，组间按 submissionGroupId 升序（提交先后）。
   * 仅返回 viewer 有权访问的记录（自己提交，或viewer 为审批链中审批人/管理员，见路由层鉴权）。
   */
  async getModificationChain(recordId: number) {
    const seed = await this.repo.findOne({ where: { id: recordId } });
    if (!seed) throw new BusinessError('记录不存在');
    const rootGroupId = seed.rootGroupId ?? seed.submissionGroupId;
    if (!rootGroupId) return { rootGroupId: null, groups: [] };

    const records = await this.repo.find({
      where: { rootGroupId },
      relations: ['project'],
      order: { submissionGroupId: 'ASC', date: 'ASC', id: 'ASC' },
    });

    // 兜底：极少数历史数据可能 rootGroupId 为空但 submissionGroupId 匹配（旧链）
    if (records.length === 0) {
      return { rootGroupId, groups: [] };
    }

    const byGroup = new Map<number, Timesheet[]>();
    for (const r of records) {
      const gid = r.submissionGroupId ?? rootGroupId;
      const bucket = byGroup.get(gid) ?? [];
      bucket.push(r);
      byGroup.set(gid, bucket);
    }

    const groups = [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([groupId, recs]) => ({
        submissionGroupId: groupId,
        previousGroupId: recs[0].previousGroupId ?? null,
        rootGroupId: recs[0].rootGroupId ?? groupId,
        status: recs[0].status,
        projectId: recs[0].projectId,
        projectName: recs[0].project?.name ?? null,
        description: recs[0].description ?? null,
        createdAt: recs[0].createdAt,
        updatedAt: recs[0].updatedAt,
        totalDays: round2(recs.reduce((s, r) => s + Number(r.days), 0)),
        entries: recs.map(r => ({ id: r.id, date: r.date, days: Number(r.days) })),
      }));

    return { rootGroupId, groups };
  }

  /** 周汇总 — 按 date 取最大 submissionGroupId（最新版本）去重 */
  async getWeeklySummary(userId: number, weekStart: string, weekEnd: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
      relations: ['project'],
    });

    const records = dedupByLatestSubmissionGroup(rawRecords);

    const byDate: Record<string, number> = {};
    for (const r of records) {
      byDate[r.date] = round2((byDate[r.date] || 0) + Number(r.days));
    }
    const totalDays = round2(Object.values(byDate).reduce((s, h) => s + h, 0));

    const byProject = records.reduce((acc, r) => {
      const key = r.project?.name || '未分配';
      acc[key] = round2((acc[key] || 0) + Number(r.days));
      return acc;
    }, {} as Record<string, number>);

    return { totalDays, byProject, records };
  }
}
