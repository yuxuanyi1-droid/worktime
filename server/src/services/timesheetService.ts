import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { SystemSetting } from '../entities/SystemSetting';
import { ApprovalRecord } from '../entities/ApprovalRecord';
import { Between, In, Not } from 'typeorm';
import { NotificationService } from './notificationService';
import { User } from '../entities/User';
import { ApprovalInstanceService } from './approvalInstanceService';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
dayjs.extend(isoWeek);

function dayjsExt(d: string | dayjs.Dayjs) { return dayjs(d); }

export class TimesheetService {
  private repo = AppDataSource.getRepository(Timesheet);
  private recordRepo = AppDataSource.getRepository(ApprovalRecord);
  private approvalInstanceService = new ApprovalInstanceService();
  private notificationService = new NotificationService();
  private userRepo = AppDataSource.getRepository(User);
  private settingRepo = AppDataSource.getRepository(SystemSetting);

  /** 检查工时锁定 */
  private async checkTimesheetLock(dates: string[]) {
    const lockSetting = await this.settingRepo.findOne({ where: { key: 'timesheet_lock_day' } });
    if (!lockSetting?.value) return;
    const lockDay = parseInt(lockSetting.value, 10);
    if (isNaN(lockDay) || lockDay < 1 || lockDay > 28) return;
    const now = dayjs();
    const currentMonthStart = now.startOf('month');
    const previousMonthStart = currentMonthStart.subtract(1, 'month');
    for (const date of dates) {
      const d = dayjs(date);
      const isOlderThanPreviousMonth = d.isBefore(previousMonthStart, 'day');
      const isPreviousMonthAfterLockDay = d.isBefore(currentMonthStart, 'day') && now.date() > lockDay;
      if (isOlderThanPreviousMonth || isPreviousMonthAfterLockDay) {
        throw new Error(`${date} 是上月的工时，每月${lockDay}号后不允许提交上月工时`);
      }
    }
  }

  async create(data: { userId: number; projectId: number; date: string; hours: number; description?: string }) {
    const record = this.repo.create(data);
    return this.repo.save(record);
  }

  async batchCreate(userId: number, items: { projectId: number; date: string; hours: number; description?: string }[]) {
    const records = items.map(item => this.repo.create({ ...item, userId }));
    return this.repo.save(records);
  }

  async update(id: number, userId: number, data: { projectId?: number; hours?: number; description?: string }) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new Error('记录不存在');
    if (record.userId !== userId) throw new Error('只能修改自己的工时记录');
    if (record.status !== 'draft') throw new Error('仅草稿状态可修改');
    Object.assign(record, data);
    return this.repo.save(record);
  }

  async delete(id: number, userId: number) {
    const record = await this.repo.findOne({ where: { id } });
    if (!record) throw new Error('记录不存在');
    if (record.userId !== userId) throw new Error('只能删除自己的工时记录');
    if (record.status !== 'draft') throw new Error('仅草稿状态可删除');
    return this.repo.delete(id);
  }

  /** 查询用户工时列表 */
  async getByUser(userId: number, params: { startDate?: string; endDate?: string; status?: string; page?: number; pageSize?: number; includeAll?: boolean }) {
    const { startDate, endDate, status, page = 1, pageSize = 50, includeAll } = params;
    const qb = this.repo.createQueryBuilder('t')
      .leftJoinAndSelect('t.project', 'p')
      .where('t.userId = :userId', { userId });

    // includeAll=true（历史记录）包含 deprecated；否则排除
    if (!includeAll) {
      qb.andWhere('t.status != :deprecated', { deprecated: 'deprecated' });
    }

    if (startDate && endDate) {
      qb.andWhere('t.date BETWEEN :startDate AND :endDate', { startDate, endDate });
    }
    if (status) {
      qb.andWhere('t.status = :status', { status });
    }

    qb.orderBy('t.date', 'DESC');
    const total = await qb.getCount();
    const rawList = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    // includeAll=true 时不去重（用于历史记录展示所有提交/修改记录）
    if (includeAll) {
      return { list: rawList, total, page, pageSize };
    }

    // 按 (date, projectId) 去重：同一天同一项目只保留 ID 最大的
    const dedupMap = new Map<string, Timesheet>();
    for (const r of rawList) {
      const key = `${r.date}_${r.projectId}`;
      const existing = dedupMap.get(key);
      if (!existing || r.id > existing.id) {
        dedupMap.set(key, r);
      }
    }
    const list = Array.from(dedupMap.values()).sort((a, b) => b.date.localeCompare(a.date));
    return { list, total: list.length, page, pageSize };
  }

  /** 按日期范围查询 — 排除 deprecated，按 (date, projectId) 去重 */
  async getByDateRange(userId: number, startDate: string, endDate: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(startDate, endDate), status: Not('deprecated') },
      relations: ['project'],
      order: { date: 'ASC' },
    });
    const dedupMap = new Map<string, Timesheet>();
    for (const r of rawRecords) {
      const key = `${r.date}_${r.projectId}`;
      const existing = dedupMap.get(key);
      if (!existing || r.id > existing.id) {
        dedupMap.set(key, r);
      }
    }
    return Array.from(dedupMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 提交审批 */
  async submit(ids: number[], userId: number) {
    if (!ids?.length) throw new Error('请选择要提交的记录');
    const records = await this.repo.findBy({ id: In(ids) });
    for (const r of records) {
      if (r.userId !== userId) throw new Error('只能提交自己的工时记录');
      if (r.status !== 'draft') throw new Error(`记录 ${r.id} 不是草稿状态，无法提交`);
    }
    const submitter = await this.userRepo.findOneBy({ id: userId });
    for (const r of records) {
      const resolved = await this.approvalInstanceService.start({
        targetType: 'timesheet',
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
            'timesheet',
            r.id,
            submitter.realName,
            `工时审批 ${r.hours}天`,
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

  /**
   * 按行提交审批
   * 
   * 关键设计：
   * - previousGroupId 只从本次提交前已存在的草稿记录获取（由 modifySubmitted 设置）
   * - 新提交的记录不会互相影响
   * - 每个项目行独立分配 submissionGroupId，审批也是独立的
   */
  async submitByRows(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; hours: number }[] }[]) {
    if (!rows?.length) throw new Error('请选择要提交的记录');

    const allDates = rows.flatMap(r => r.entries.map(e => e.date));
    await this.checkTimesheetLock(allDates);

    // 单日工时校验
    const dailyHours: Record<string, number> = {};
    for (const row of rows) {
      for (const e of row.entries) {
        dailyHours[e.date] = (dailyHours[e.date] || 0) + e.hours;
      }
    }
    for (const [date, total] of Object.entries(dailyHours)) {
      if (total > 24) {
        throw new Error(`${date} 工时合计 ${total.toFixed(1)} 小时，超过24小时上限`);
      }
    }

    // ★ 关键：在处理任何行之前，先获取 previousGroupId
    // 只从已存在的草稿记录的 previousGroupId 字段获取（由 modifySubmitted 设置）
    const weekStart = rows[0].weekStart;
    const weekEnd = dayjsExt(weekStart).add(6, 'day').format('YYYY-MM-DD');

    // ★ 查找已有的 draft、rejected 和 approved 记录
    // approved 支持修改后重新提交（仅修改的行会传入）
    const existingRecords = await this.repo.find({
      where: [
        { userId, date: Between(weekStart, weekEnd), status: 'draft' },
        { userId, date: Between(weekStart, weekEnd), status: 'rejected' },
        { userId, date: Between(weekStart, weekEnd), status: 'approved' },
        { userId, date: Between(weekStart, weekEnd), status: 'submitted' },
      ],
    });

    // 从已存在记录中获取 previousGroupId
    const recWithPrev = existingRecords.find(e => e.previousGroupId);
    const previousGroupId = recWithPrev?.previousGroupId || null;

    // 生成 submissionGroupId
    const maxGroup = await this.repo.createQueryBuilder('t')
      .select('MAX(t.submissionGroupId)', 'maxId')
      .getRawOne();
    let nextGroupId = (maxGroup?.maxId || 0) + 1;

    // 收集每个提交项目的日期
    const projectDates = new Map<number, Set<string>>();
    const allEntryDates = new Set<string>();
    for (const row of rows) {
      const dates = new Set<string>();
      for (const e of row.entries) {
        if (e.hours > 0) {
          dates.add(e.date);
          allEntryDates.add(e.date);
        }
      }
      projectDates.set(row.projectId, dates);
    }

    // ★ 清理：处理不在新条目中的旧记录
    const removedIds = new Set<number>();
    for (const rec of existingRecords) {
      const dates = projectDates.get(rec.projectId);
      const isInEntries = dates ? dates.has(rec.date) : allEntryDates.has(rec.date);

      if (rec.status === 'rejected') {
        // 驳回记录：仅当该项目正在被重新提交时清理不在 entries 中的
        if (dates && !isInEntries) {
          await this.repo.remove(rec);
          removedIds.add(rec.id);
        }
      } else if (rec.status === 'draft') {
        if (!isInEntries) {
          // 草稿记录不在提交条目中
          if (rec.submissionGroupId) {
            // 从旧提交转来的草稿：标记为 deprecated 保留历史
            rec.status = 'deprecated';
            await this.repo.save(rec);
          } else {
            // 普通草稿：直接删除
            await this.repo.remove(rec);
          }
          removedIds.add(rec.id);
        }
      } else if (rec.status === 'approved' || rec.status === 'submitted') {
        // ★ 已审批/已提交记录：仅处理正在被重新提交的项目行
        // 不在 entries 中的日期 → 标记为 deprecated（比如4天改3天，第4天废弃）
        if (dates && !isInEntries) {
          rec.status = 'deprecated';
          await this.repo.save(rec);
          removedIds.add(rec.id);
        }
      }
    }

    // 按行处理
    for (const row of rows) {
      if (!row.entries?.length) continue;

      const records: Timesheet[] = [];

      for (const entry of row.entries) {
        if (entry.hours <= 0) continue;

        // 查找该日期该项目的已有记录
        const existingRec = existingRecords.find(
          d => !removedIds.has(d.id) && d.date === entry.date && d.projectId === row.projectId
        );

        if (existingRec && existingRec.status === 'draft') {
          if (existingRec.submissionGroupId) {
            // ★ 从旧提交转来的草稿（modifySubmitted 转的）：保留旧草稿为历史，创建全新记录
            const oldSubGroupId = existingRec.submissionGroupId;
            existingRec.status = 'deprecated';
            await this.repo.save(existingRec);
            removedIds.add(existingRec.id);
            records.push(this.repo.create({
              userId,
              projectId: row.projectId,
              date: entry.date,
              hours: entry.hours,
              description: row.description,
              previousGroupId: oldSubGroupId,
            }));
          } else {
            // 普通草稿：原地更新
            existingRec.hours = entry.hours;
            existingRec.description = row.description || existingRec.description;
            records.push(existingRec);
          }
        } else if (existingRec && (existingRec.status === 'rejected' || existingRec.status === 'approved' || existingRec.status === 'submitted')) {
          // ★ rejected/approved/submitted 记录：旧记录标记为 deprecated，创建全新记录
          const oldSubGroupId = existingRec.submissionGroupId;
          // 如果是 submitted 状态，创建撤回审批记录
          if (existingRec.status === 'submitted') {
            const submitter = await this.userRepo.findOneBy({ id: userId });
            if (submitter) {
              await this.approvalInstanceService.withdraw('timesheet', existingRec.id, userId, submitter.realName);
              await this.recordRepo.save(this.recordRepo.create({
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
            }
          }
          existingRec.status = 'deprecated';
          await this.repo.save(existingRec);
          removedIds.add(existingRec.id);
          records.push(this.repo.create({
            userId,
            projectId: row.projectId,
            date: entry.date,
            hours: entry.hours,
            description: row.description,
            previousGroupId: oldSubGroupId || previousGroupId,
          }));
        } else {
          // 创建新记录
          records.push(this.repo.create({
            userId,
            projectId: row.projectId,
            date: entry.date,
            hours: entry.hours,
            description: row.description,
            previousGroupId,
          }));
        }
      }

      if (records.length === 0) continue;

      // ★ 获取该行的 previousGroupId：从该项目的旧记录中获取（含已 deprecated 的）
      const rowPrevGroup = existingRecords
        .filter(r => r.projectId === row.projectId && r.submissionGroupId
          && (r.status !== 'draft' || removedIds.has(r.id)))
        .sort((a, b) => b.id - a.id)[0];

      // 设置 submissionGroupId
      for (const r of records) {
        r.submissionGroupId = nextGroupId;
        r.previousGroupId = rowPrevGroup?.submissionGroupId || previousGroupId;
      }
      await this.repo.save(records);

      // 解析审批流程
      const targetId = records[0].id;
      const resolved = await this.approvalInstanceService.start({
        targetType: 'timesheet',
        targetId,
        applicantId: userId,
        projectId: row.projectId,
      });
      if (resolved.status === 'submitted' && resolved.instance) {
        await this.repo.update(
          { id: In(records.map(r => r.id)) },
          {
            status: 'submitted',
            currentStep: resolved.instance.currentStepOrder || 1,
            approvalFlowId: resolved.instance.flowId,
            approvalInstanceId: resolved.instance.id,
            totalSteps: resolved.instance.totalSteps,
          },
        );
        // 通知审批人
        try {
          const submitter = await this.userRepo.findOneBy({ id: userId });
          if (resolved.firstApproverIds.length && submitter) {
            const totalHours = row.entries.reduce((s, e) => s + e.hours, 0);
            await this.notificationService.notifyApprovalPending(
              resolved.firstApproverIds,
              'timesheet',
              targetId,
              submitter.realName,
              `工时审批 ${totalHours}天`,
            );
          }
        } catch {}
      } else {
        await this.repo.update(
          { id: In(records.map(r => r.id)) },
          {
            status: 'approved',
            currentStep: 0,
            totalSteps: 0,
            approvalInstanceId: resolved.instance?.id ?? null,
          },
        );
      }

      nextGroupId++;
    }
    return true;
  }

  /**
   * 修改已提交/已审批的工时 — 整周统一处理
   * 
   * 核心逻辑：
   * 1. 收集所有行的所有条目，作为一个整体处理
   * 2. 将整周所有 active 记录转为 draft（保留 submissionGroupId 供后续废弃）
   * 3. 根据所有条目更新/创建草稿
   * 4. 新草稿设置 previousGroupId 指向旧的 submissionGroupId
   * 5. 审批通过后，旧的记录（submissionGroupId = previousGroupId）会被标记为 deprecated
   */
  async modifySubmitted(userId: number, rows: { projectId: number; description: string; weekStart: string; entries: { date: string; hours: number }[] }[]) {
    if (!rows?.length) throw new Error('请提供要修改的记录');

    // ★ 所有行共享同一个 weekStart，整周统一处理
    const weekStart = rows[0].weekStart;
    const weekEnd = dayjsExt(weekStart).add(6, 'day').format('YYYY-MM-DD');

    // 1. 查询该周所有记录
    const allExisting = await this.repo.find({
      where: { userId, date: Between(weekStart, weekEnd) },
    });
    const activeRecords = allExisting.filter(r => r.status !== 'deprecated');

    // 2. 获取 previousGroupId：从非草稿记录的 submissionGroupId 获取
    const nonDraftRecord = activeRecords.find(e => e.status !== 'draft' && e.submissionGroupId);
    const previousGroupId = nonDraftRecord?.submissionGroupId || null;

    // 3. 创建撤回审批记录
    const submittedRecords = activeRecords.filter(e => e.status === 'submitted');
    if (submittedRecords.length > 0) {
      const submitter = await this.userRepo.findOneBy({ id: userId });
      if (submitter) {
        for (const e of submittedRecords) {
          await this.approvalInstanceService.withdraw('timesheet', e.id, userId, submitter.realName);
          await this.recordRepo.save(this.recordRepo.create({
            targetType: 'timesheet',
            targetId: e.id,
            instanceId: e.approvalInstanceId ?? null,
            approverId: userId,
            approverName: submitter.realName,
            action: 'withdraw',
            comment: '申请人撤回修改工时',
            stepOrder: e.currentStep || 1,
            stepType: 'withdraw',
            stepLabel: '撤回',
          }));
        }
      }
    }

    // 4. 将所有 submitted/approved 记录转为 draft
    //    ★ 保留 submissionGroupId（不清除），供审批通过后废弃旧记录
    for (const e of activeRecords) {
      if (e.status === 'submitted' || e.status === 'approved') {
        e.status = 'draft';
        e.currentStep = 0;
        e.approvalFlowId = null;
        e.approvalInstanceId = null;
        e.totalSteps = 0;
        // 保留 submissionGroupId！不清除！
        e.previousGroupId = previousGroupId;
        await this.repo.save(e);
      }
    }

    // 5. ★ 收集所有行的所有条目（整周统一处理）
    const allEntries = new Map<string, { date: string; projectId: number; hours: number; description: string }>();
    for (const row of rows) {
      for (const entry of row.entries) {
        if (entry.hours > 0) {
          allEntries.set(`${entry.date}_${row.projectId}`, {
            date: entry.date,
            projectId: row.projectId,
            hours: entry.hours,
            description: row.description,
          });
        }
      }
    }

    const allEntryKeys = new Set(allEntries.keys());


    // 6. 重新加载活跃记录（现在全部是 draft）
    const freshRecords = await this.repo.find({
      where: { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
    });

    // 按日期索引（每天可能有多个项目的记录，都保留）
    const existingByDateProject = new Map<string, Timesheet>();
    for (const r of freshRecords) {
      const key = `${r.date}_${r.projectId}`;
      const existing = existingByDateProject.get(key);
      if (!existing || r.id > existing.id) {
        existingByDateProject.set(key, r);
      }
    }

    // 7. 删除不在任何行条目中的日期的旧草稿
    //    ★ 但只删除没有 submissionGroupId 的草稿（新创建的中间草稿）
    //    有 submissionGroupId 的保留（供审批后废弃）
    for (const [key, record] of existingByDateProject) {
      if (!allEntryKeys.has(key)) {
        if (!record.submissionGroupId) {

          // 没有关联旧提交的草稿，可以安全删除
          await this.repo.remove(record);
        } else {
          // 有关联旧提交的记录，标记为 deprecated（保留修改历史）
          record.status = 'deprecated';
          await this.repo.save(record);
        }
        existingByDateProject.delete(key);
      }
    }

    // 8. 处理每个条目
    for (const entry of allEntries.values()) {
      const existingKey = `${entry.date}_${entry.projectId}`;
      const existingRecord = existingByDateProject.get(existingKey);


      if (existingRecord) {
        // 同项目同日期：原地更新
        existingRecord.hours = entry.hours;
        existingRecord.description = entry.description || existingRecord.description;
        existingRecord.previousGroupId = previousGroupId;
        await this.repo.save(existingRecord);
      } else {
        // 检查该日期是否有旧项目的记录
        const oldRecordForDate = freshRecords.find(r => r.date === entry.date && r.submissionGroupId);
        if (oldRecordForDate && oldRecordForDate.projectId !== entry.projectId) {

          // 项目变更：旧记录标记为 deprecated，创建新草稿
          oldRecordForDate.status = 'deprecated';
          await this.repo.save(oldRecordForDate);
        }

        // 创建新草稿
        await this.repo.save(this.repo.create({
          userId,
          projectId: entry.projectId,
          date: entry.date,
          hours: entry.hours,

          description: entry.description,
          previousGroupId,
        }));
      }
    }

    return true;
  }

  /** 周汇总 — 排除 deprecated，按 (date, projectId) 去重 */
  async getWeeklySummary(userId: number, weekStart: string, weekEnd: string) {
    const rawRecords = await this.repo.find({
      where: { userId, date: Between(weekStart, weekEnd), status: Not('deprecated') },
      relations: ['project'],
    });

    // 按 (date, projectId) 去重：同一天同一项目只保留 ID 最大的
    const dedupMap = new Map<string, Timesheet>();
    for (const r of rawRecords) {
      const key = `${r.date}_${r.projectId}`;
      const existing = dedupMap.get(key);
      if (!existing || r.id > existing.id) {
        dedupMap.set(key, r);
      }
    }
    const records = Array.from(dedupMap.values());

    // 按日期汇总工时（同一天不同项目的工时会累加）
    const byDate: Record<string, number> = {};
    for (const r of records) {
      byDate[r.date] = (byDate[r.date] || 0) + Number(r.hours);
    }
    const totalHours = Object.values(byDate).reduce((s, h) => s + h, 0);

    // 按项目汇总
    const byProject = records.reduce((acc, r) => {
      const key = r.project?.name || '未分配';
      acc[key] = (acc[key] || 0) + Number(r.hours);
      return acc;
    }, {} as Record<string, number>);

    return { totalHours, byProject, records };
  }
}
