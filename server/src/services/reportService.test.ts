import { describe, it, expect } from 'vitest';
import { dedupReportTimesheets } from './reportService';
import { Timesheet } from '../entities/Timesheet';

/** 构造测试用 Timesheet（只填去重逻辑关心的字段） */
function mk(
  id: number, userId: number, date: string, projectId: number, days: number,
  status: Timesheet['status'] = 'approved', submissionGroupId: number = 1,
): Timesheet {
  return { id, userId, date, projectId, days, status, submissionGroupId } as Timesheet;
}

describe('dedupReportTimesheets', () => {
  it('空数组返回空', () => {
    expect(dedupReportTimesheets([])).toEqual([]);
  });

  it('同一天多项目（同 submissionGroup）各自保留', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 0.5, 'approved', 1),
      mk(2, 10, '2024-01-01', 200, 0.5, 'approved', 1),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(2);
  });

  it('不同用户同日期互不影响', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'approved', 1),
      mk(2, 20, '2024-01-01', 100, 6, 'approved', 2),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(2);
  });

  it('不同日期各自独立', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'approved', 1),
      mk(2, 10, '2024-01-02', 100, 6, 'approved', 1),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(2);
  });

  it('排除 deprecated/submitted/draft/rejected（只保留 approved）', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'deprecated'),
      mk(2, 10, '2024-01-02', 100, 6, 'approved'),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('submitted 不参与报表统计（即使没有 approved）', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'submitted', 2),
    ];
    expect(dedupReportTimesheets(records)).toEqual([]);
  });

  it('版本化：v1 approved + v2 submitted → 取 v1', () => {
    // v1 已审批，v2 审批中 → 报表只统计 approved，取 v1
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'approved', 1),
      mk(2, 10, '2024-01-01', 200, 3, 'submitted', 2), // 新版本换项目了
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
    expect(result[0].days).toBe(8);
  });

  it('版本化：v1 deprecated + v2 approved → 取 v2', () => {
    // v2 审批通过后 v1 被 deprecate → 报表取 v2
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'deprecated', 1),
      mk(2, 10, '2024-01-01', 200, 3, 'approved', 2),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
    expect(result[0].days).toBe(3);
  });

  it('版本化：同一天多版本 approved 取最大 submissionGroupId', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'approved', 1), // v1
      mk(2, 10, '2024-01-01', 100, 6, 'approved', 2), // v2（更大的 submissionGroup）
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
    expect(result[0].days).toBe(6);
  });

  it('版本化：同一天 v1 多项目 approved + v2 submitted → 取 v1 全部记录', () => {
    // v1: A 0.5 + B 0.5 (approved, submissionGroupId=1)
    // v2: C 1.0 (submitted, submissionGroupId=2) — 审批中
    // 报表应统计 v1 的 A+B = 1.0
    const records = [
      mk(1, 10, '2024-01-01', 100, 0.5, 'approved', 1),
      mk(2, 10, '2024-01-01', 200, 0.5, 'approved', 1),
      mk(3, 10, '2024-01-01', 300, 1.0, 'submitted', 2),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(2);
    const total = result.reduce((s, r) => s + r.days, 0);
    expect(total).toBe(1.0);
  });

  it('同一天多项目各自独立 submissionGroupId 且都 approved → 都保留（核心 bug 修复场景）', () => {
    // submitByRows 每个项目独立分配 submissionGroupId。
    // 旧实现按 (userId, date) 取 MAX group 会只留 group 最大的项目，丢失其他项目。
    // 修复后按 (userId, projectId, date) 取 MAX group，3 个项目各自保留。
    const records = [
      mk(1, 10, '2024-01-01', 100, 0.3, 'approved', 10), // 项目100 group10
      mk(2, 10, '2024-01-01', 200, 0.3, 'approved', 9),  // 项目200 group9
      mk(3, 10, '2024-01-01', 300, 0.4, 'approved', 8),  // 项目300 group8
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(3);
    const total = result.reduce((s, r) => s + r.days, 0);
    expect(total).toBe(1.0);
  });
});
