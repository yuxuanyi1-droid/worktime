import { describe, it, expect } from 'vitest';
import { dedupByLatestSubmissionGroup } from './timesheetService';
import { Timesheet } from '../entities/Timesheet';

/** 构造测试用 Timesheet（只填去重逻辑关心的字段） */
function mk(
  id: number, projectId: number, date: string, hours: number,
  status: Timesheet['status'] = 'submitted', submissionGroupId: number = 1,
): Timesheet {
  return { id, projectId, date, hours, status, submissionGroupId } as Timesheet;
}

describe('dedupByLatestSubmissionGroup', () => {
  it('空数组返回空', () => {
    expect(dedupByLatestSubmissionGroup([])).toEqual([]);
  });

  it('同一天多项目不同 submissionGroupId → 各自保留（核心 bug 修复场景）', () => {
    // submitByRows 每个项目独立分配 submissionGroupId，同一天 3 个项目 3 个 group
    const records = [
      mk(1, 100, '2026-07-13', 0.6, 'submitted', 10), // 工时管理系统
      mk(2, 200, '2026-07-13', 0.2, 'submitted', 9),  // 电商平台
      mk(3, 300, '2026-07-13', 0.2, 'submitted', 8),  // 内部OA系统
    ];
    const result = dedupByLatestSubmissionGroup(records);
    expect(result).toHaveLength(3);
    const total = result.reduce((s, r) => s + r.hours, 0);
    expect(total).toBe(1.0);
  });

  it('同一天多项目整周（多天）各自保留', () => {
    const records = [
      mk(1, 100, '2026-07-13', 0.6, 'submitted', 10),
      mk(2, 100, '2026-07-14', 0.6, 'submitted', 10),
      mk(3, 200, '2026-07-13', 0.2, 'submitted', 9),
      mk(4, 200, '2026-07-14', 0.2, 'submitted', 9),
      mk(5, 300, '2026-07-13', 0.2, 'submitted', 8),
      mk(6, 300, '2026-07-14', 0.2, 'submitted', 8),
    ];
    const result = dedupByLatestSubmissionGroup(records);
    expect(result).toHaveLength(6);
    const projectIds = new Set(result.map(r => r.projectId));
    expect(projectIds.size).toBe(3);
  });

  it('同一项目同一天多版本 → 取最大 submissionGroupId（最新版）', () => {
    const records = [
      mk(1, 100, '2026-07-13', 0.5, 'submitted', 1), // v1
      mk(2, 100, '2026-07-13', 0.8, 'submitted', 5), // v2（更新版本）
    ];
    const result = dedupByLatestSubmissionGroup(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
    expect(result[0].hours).toBe(0.8);
  });

  it('不同项目不同日期互不影响', () => {
    const records = [
      mk(1, 100, '2026-07-13', 0.5, 'submitted', 1),
      mk(2, 200, '2026-07-14', 0.6, 'submitted', 2),
    ];
    const result = dedupByLatestSubmissionGroup(records);
    expect(result).toHaveLength(2);
  });

  it('排除 deprecated/rejected/withdrawn', () => {
    const records = [
      mk(1, 100, '2026-07-13', 0.5, 'deprecated', 1),
      mk(2, 100, '2026-07-13', 0.6, 'submitted', 2),
      mk(3, 200, '2026-07-13', 0.3, 'rejected', 3),
      mk(4, 300, '2026-07-13', 0.4, 'withdrawn', 4),
    ];
    const result = dedupByLatestSubmissionGroup(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('submissionGroupId 为 null 的记录不参与去重比较', () => {
    // draft（未提交）记录 submissionGroupId 为 null，应被过滤掉
    const records = [
      mk(1, 100, '2026-07-13', 0.5, 'draft', 0),
      mk(2, 100, '2026-07-13', 0.6, 'submitted', 2),
    ];
    const fixedDraft = { ...records[0], submissionGroupId: null } as Timesheet;
    const result = dedupByLatestSubmissionGroup([fixedDraft, records[1]]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });
});
