/**
 * 工时配额消耗的公共计算工具。
 *
 * 单一事实来源：审批单的配额警告（approvalService.buildTimesheetQuota）与报表层的
 * 超投统计（reportService.getOverrunStats）必须使用同一口径，否则两边数字对不上：
 * - 消耗范围：status IN ('submitted','approved')
 * - 版本去重：同一 (userId, projectId, date) 只计最新 submissionGroupId 的记录
 *   （审批窗口期旧 approved 版本保留时不计入双份）
 * - 历史无组号记录：仅当该 (userId, projectId, date) 不存在带组号记录时计入
 */
import { round2 } from './validation';

export interface ConsumptionRow {
  userId: number;
  projectId: number;
  date: string;
  days: string | number;
  submissionGroupId: number | null;
}

/** 按 (userId, projectId, date) 取最新 submissionGroupId 去重后求和（人/天）。 */
export function sumConsumption(rows: ConsumptionRow[]): number {
  const maxGroupByKey = new Map<string, number>();
  for (const r of rows) {
    if (!r.submissionGroupId) continue;
    const key = `${r.userId}_${r.projectId}_${r.date}`;
    const cur = maxGroupByKey.get(key);
    if (cur === undefined || r.submissionGroupId > cur) maxGroupByKey.set(key, r.submissionGroupId);
  }
  let total = 0;
  for (const r of rows) {
    if (r.submissionGroupId) {
      // 有组号的版本：只计该 (userId, projectId, date) 下最新组的记录
      if (r.submissionGroupId !== maxGroupByKey.get(`${r.userId}_${r.projectId}_${r.date}`)) continue;
    } else if (maxGroupByKey.has(`${r.userId}_${r.projectId}_${r.date}`)) {
      // 历史无组号记录：仅当该 key 不存在带组号的活跃记录时计入
      continue;
    }
    total = round2(total + Number(r.days));
  }
  return total;
}

/**
 * 配额组覆盖集合：配额配在某个组时，消耗统计范围 = 该组及其全部子孙组
 * （与 UserAudienceService.getGroupAndDescendantIds 的 path 前缀语义一致）。
 * @param groups 全量组（含 path 字段）
 * @param quotaGroupId 配额配置所在的组
 */
export function collectGroupCoverage(groups: Array<{ id: number; path: string | null }>, quotaGroupId: number): Set<number> {
  const target = groups.find((g) => g.id === quotaGroupId);
  if (!target) return new Set();
  const path = target.path || String(target.id);
  const ids = new Set<number>([target.id]);
  for (const g of groups) {
    if (g.path && (g.path === path || g.path.startsWith(`${path}/`))) {
      ids.add(g.id);
    }
  }
  return ids;
}
