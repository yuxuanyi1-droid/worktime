import { describe, it, expect } from 'vitest';
import { dedupReportTimesheets } from './reportService';
import { Timesheet } from '../entities/Timesheet';

/** 构造测试用 Timesheet（只填去重逻辑关心的字段） */
function mk(id: number, userId: number, date: string, projectId: number, hours: number, status: Timesheet['status'] = 'approved'): Timesheet {
  return { id, userId, date, projectId, hours, status } as Timesheet;
}

describe('dedupReportTimesheets', () => {
  it('空数组返回空', () => {
    expect(dedupReportTimesheets([])).toEqual([]);
  });

  it('不同 (userId, date, projectId) 全部保留', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8),
      mk(2, 10, '2024-01-02', 100, 6),
      mk(3, 20, '2024-01-01', 100, 7), // 不同用户
      mk(4, 10, '2024-01-01', 200, 4), // 不同项目
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(4);
  });

  it('同 key 保留 id 最大的（最新版本）', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8),  // 旧版本
      mk(5, 10, '2024-01-01', 100, 3),  // 新版本（修改后）
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(5);
    expect(result[0].hours).toBe(3);
  });

  it('排除 deprecated 状态（已被新版本替代的废弃记录）', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'deprecated'), // 废弃，应排除
      mk(2, 10, '2024-01-02', 100, 6, 'approved'),   // 正常
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('deprecated 即使是唯一记录也排除（不会出现孤儿）', () => {
    const records = [mk(1, 10, '2024-01-01', 100, 8, 'deprecated')];
    expect(dedupReportTimesheets(records)).toEqual([]);
  });

  it('approved 与 submitted 混合时都保留（去重不按状态，按 id）', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'approved'),
      mk(2, 10, '2024-01-02', 100, 6, 'submitted'),
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(2);
  });

  it('模拟修改审批场景：旧 deprecated + 新 submitted，只保留新版本', () => {
    // 员工 1 月 1 日填了 8 天 → 审批通过 → 改成 3 天重新提交
    const records = [
      mk(1, 10, '2024-01-01', 100, 8, 'deprecated'), // 旧版本（已废弃）
      mk(2, 10, '2024-01-01', 100, 3, 'submitted'),  // 新版本（审批中）
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
    expect(result[0].hours).toBe(3); // 报表统计最新版本的 3 天，而非旧的 8 天
  });

  it('多用户同日期同项目互不影响', () => {
    const records = [
      mk(1, 10, '2024-01-01', 100, 8),
      mk(2, 20, '2024-01-01', 100, 6), // 不同用户，同日期同项目
      mk(3, 10, '2024-01-01', 100, 4), // 与记录1同key，保留id更大的3
    ];
    const result = dedupReportTimesheets(records);
    expect(result).toHaveLength(2);
    const userIds = result.map(r => r.userId).sort();
    expect(userIds).toEqual([10, 20]);
    // userId=10 的应取 id=3 那条
    const u10 = result.find(r => r.userId === 10)!;
    expect(u10.id).toBe(3);
  });
});
