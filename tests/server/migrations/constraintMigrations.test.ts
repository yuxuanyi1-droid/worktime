import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { PermissionGrantConsistency1700000000014 } from '@server/migrations/1700000000014-PermissionGrantConsistency';
import { OrganizationSiblingConstraint1700000000015 } from '@server/migrations/1700000000015-OrganizationSiblingConstraint';
import { ExternalIdentityProviderConstraint1700000000016 } from '@server/migrations/1700000000016-ExternalIdentityProviderConstraint';
import { DataIntegrityConstraints1700000000017 } from '@server/migrations/1700000000017-DataIntegrityConstraints';

function queryRunner() {
  return { query: vi.fn().mockResolvedValue([]) } as unknown as QueryRunner;
}

describe('并发一致性约束 migration', () => {
  it.each([
    ['权限申请和授权', new PermissionGrantConsistency1700000000014(), 2],
    ['组织同级分组', new OrganizationSiblingConstraint1700000000015(), 1],
    ['外部身份绑定', new ExternalIdentityProviderConstraint1700000000016(), 1],
  ])('%s 在建索引前检查存量冲突，且空库同步后可幂等执行', async (_name, migration, indexCount) => {
    const runner = queryRunner();
    await migration.up(runner);
    const sql = vi.mocked(runner.query).mock.calls.map(([statement]) => String(statement).replace(/\s+/g, ' ').trim());
    const checks = sql.filter((statement) => statement.startsWith('DO $$'));
    const indexes = sql.filter((statement) => statement.startsWith('CREATE UNIQUE INDEX'));

    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(indexes).toHaveLength(indexCount);
    expect(indexes.every((statement) => statement.includes('IF NOT EXISTS'))).toBe(true);
    expect(sql.indexOf(checks[0])).toBeLessThan(sql.indexOf(indexes[0]));
  });

  it.each([
    new PermissionGrantConsistency1700000000014(),
    new OrganizationSiblingConstraint1700000000015(),
    new ExternalIdentityProviderConstraint1700000000016(),
  ])('$name 的 down 只移除本次索引并允许重复清理', async (migration) => {
    const runner = queryRunner();
    await migration.down(runner);
    const sql = vi.mocked(runner.query).mock.calls.map(([statement]) => String(statement).replace(/\s+/g, ' ').trim());
    expect(sql.length).toBeGreaterThanOrEqual(1);
    expect(sql.every((statement) => /^DROP INDEX IF EXISTS /.test(statement))).toBe(true);
  });
});

describe('数据完整性约束 migration (0017)', () => {
  // Postgres 方言的 QueryRunner mock：hasTable 返回 true，使 up() 走到列类型修正分支
  function postgresRunner() {
    return {
      connection: { options: { type: 'postgres' } },
      query: vi.fn().mockResolvedValue([]),
      hasTable: vi.fn().mockResolvedValue(true),
    } as unknown as QueryRunner;
  }

  function sqlOf(runner: QueryRunner) {
    return vi.mocked(runner.query).mock.calls.map(([statement]) => String(statement).replace(/\s+/g, ' ').trim());
  }

  it('创建两张活跃记录唯一索引（含目标索引名）且全部幂等', async () => {
    const runner = postgresRunner();
    await new DataIntegrityConstraints1700000000017().up(runner);
    const sql = sqlOf(runner);
    const uniqueIndexes = sql.filter((statement) => statement.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS'));
    const indexNames = uniqueIndexes.map((statement) => statement.match(/"([a-z_]+)"\s+ON\s+"([a-z_]+)"/)?.[1]);

    expect(indexNames).toEqual(
      expect.arrayContaining(['uq_timesheet_active_user_project_date', 'uq_overtime_active_user_date_type']),
    );
    expect(uniqueIndexes.every((statement) => statement.includes('IF NOT EXISTS'))).toBe(true);
    // 部分唯一索引的 WHERE 条件
    expect(uniqueIndexes.some((statement) => statement.includes('WHERE "status" IN'))).toBe(true);
  });

  it('Postgres 方言将 days/totalDays 修正为 numeric(10,2)', async () => {
    const runner = postgresRunner();
    await new DataIntegrityConstraints1700000000017().up(runner);
    const alters = sqlOf(runner).filter((statement) => statement.includes('TYPE numeric(10,2)'));
    expect(alters).toHaveLength(3);
    expect(alters.every((statement) => statement.includes('"days"') || statement.includes('"totalDays"'))).toBe(true);
  });

  it('非 Postgres 方言跳过列类型修正，但仍建索引', async () => {
    const runner = {
      connection: { options: { type: 'sqlite' } },
      query: vi.fn().mockResolvedValue([]),
    } as unknown as QueryRunner;
    await new DataIntegrityConstraints1700000000017().up(runner);
    const sql = sqlOf(runner);
    expect(sql.some((statement) => statement.includes('TYPE numeric(10,2)'))).toBe(false);
    expect(sql.some((statement) => statement.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS'))).toBe(true);
  });

  it('down 只移除本次索引（Postgres 方言另含回退列类型）并允许重复清理', async () => {
    const runner = postgresRunner();
    await new DataIntegrityConstraints1700000000017().down(runner);
    const sql = sqlOf(runner);
    expect(sql.every((statement) =>
      /^DROP INDEX IF EXISTS /.test(statement) || /^ALTER TABLE .* TYPE double precision/.test(statement),
    )).toBe(true);
  });
});
