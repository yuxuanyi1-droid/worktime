import { describe, expect, it, vi } from 'vitest';
import { OvertimeApplication } from '@server/entities/OvertimeApplication';
import { getOvertimeStatsDateRange, OvertimeService } from '@server/services/overtimeService';

describe('getOvertimeStatsDateRange', () => {
  it('按月生成左闭右开的日期范围，并正确跨年', () => {
    expect(getOvertimeStatsDateRange(2026, 7)).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-08-01',
    });
    expect(getOvertimeStatsDateRange(2026, 12)).toEqual({
      startDate: '2026-12-01',
      endDate: '2027-01-01',
    });
  });

  it('按年生成日期范围', () => {
    expect(getOvertimeStatsDateRange(2026)).toEqual({
      startDate: '2026-01-01',
      endDate: '2027-01-01',
    });
  });
});

describe('OvertimeService.getStats', () => {
  it('使用 PostgreSQL 与 SQLite 都支持的日期范围查询，不依赖 strftime', async () => {
    const andWhere = vi.fn().mockReturnThis();
    const queryBuilder = {
      select: vi.fn().mockReturnThis(),
      addSelect: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      andWhere,
      groupBy: vi.fn().mockReturnThis(),
      getRawMany: vi.fn().mockResolvedValue([]),
    };
    const manager = {
      getRepository(entity: unknown) {
        if (entity === OvertimeApplication) return { createQueryBuilder: () => queryBuilder };
        return {};
      },
    };

    await new OvertimeService(manager as any).getStats(9, 2026, 7);

    expect(andWhere).toHaveBeenCalledWith(
      'o.date >= :startDate AND o.date < :endDate',
      { startDate: '2026-07-01', endDate: '2026-08-01' },
    );
    expect(andWhere.mock.calls.flat().join(' ')).not.toContain('strftime');
  });
});
