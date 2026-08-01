import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { DataSource, In, LessThan } from 'typeorm';
import { enqueueTimesheetApprovals, type TimesheetApprovalJob } from './approvalQueue';
import { logger } from '../utils/logger';

/**
 * 审批恢复扫描器（孤儿 submitted 补偿）。
 *
 * 背景：工时提交事务 commit 后、审批任务入队（Redis Stream）前，进程可能崩溃；
 * 或入队后消息被 MAXLEN 修剪/丢失——此时记录停留在 submitted 且 approvalInstanceId 为 null，
 * 审批人看不到待办，用户也无法重试（submit 要求 draft）或撤回（无实例）。
 *
 * 本扫描器定期把「提交超过阈值仍未关联审批实例」的记录按 submissionGroupId 重新入队。
 * 多实例同时执行是安全的：processApprovalJobs 先查 head 状态（deprecated/withdrawn 跳过），
 * 再复用已存在的实例（Streams 至少一次投递 + 唯一索引兜底），重复入队不会产生重复实例。
 */
export class ApprovalRecoveryService {
  /** 提交后超过该时长仍未关联审批实例的记录视为孤儿（避免与 worker 正常处理窗口重叠） */
  private static readonly ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

  async reconcile(dataSource: DataSource = AppDataSource): Promise<number> {
    if (!dataSource.isInitialized) return 0;
    const repo = dataSource.getRepository(Timesheet);
    const threshold = new Date(Date.now() - ApprovalRecoveryService.ORPHAN_THRESHOLD_MS);

    // 找所有「submitted 且无审批实例且更新超过阈值」的记录，按 submissionGroupId 分组
    const orphans = await repo.find({
      where: { status: 'submitted', approvalInstanceId: null as any, updatedAt: LessThan(threshold) },
      select: ['id', 'userId', 'projectId', 'submissionGroupId', 'days', 'updatedAt'],
      order: { updatedAt: 'ASC' },
      take: 500,
    });
    if (!orphans.length) return 0;

    // 同一 submissionGroupId 的孤儿记录合成一个审批任务（与提交时的 recordIds 一致）
    const byGroup = new Map<number, Timesheet[]>();
    for (const rec of orphans) {
      const key = rec.submissionGroupId ?? rec.id; // 无组号（历史 submit 路径）按记录本身
      const bucket = byGroup.get(key) ?? [];
      bucket.push(rec);
      byGroup.set(key, bucket);
    }

    const jobs: TimesheetApprovalJob[] = [];
    for (const bucket of byGroup.values()) {
      const head = [...bucket].sort((a, b) => b.id - a.id)[0];
      jobs.push({
        targetId: head.id,
        recordIds: bucket.map((r) => r.id),
        projectId: head.projectId,
        userId: head.userId,
        title: `工时审批 ${bucket.reduce((s, r) => s + Number(r.days), 0)}天（恢复）`,
      });
    }

    const ok = await enqueueTimesheetApprovals(jobs);
    if (!ok) {
      logger.warn({ jobs: jobs.length }, '[approval-recovery] 重新入队失败（Redis 不可用），等待下轮重试');
      return 0;
    }
    logger.info({ jobs: jobs.length, records: orphans.length }, '[approval-recovery] 已重新入队孤儿 submitted 记录');
    return jobs.length;
  }
}
