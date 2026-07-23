import { describe, expect, it, vi } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { PermissionGrantConsistency1700000000014 } from '@server/migrations/1700000000014-PermissionGrantConsistency';
import { OrganizationSiblingConstraint1700000000015 } from '@server/migrations/1700000000015-OrganizationSiblingConstraint';
import { ExternalIdentityProviderConstraint1700000000016 } from '@server/migrations/1700000000016-ExternalIdentityProviderConstraint';

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
