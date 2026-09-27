import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AppDataSource, databaseType } from './database';

/**
 * 实体 / migration 注册一致性守卫。
 *
 * AGENTS.md 要求：实体必须在 config/database.ts 的 entities 数组中显式登记（非 glob）、
 * migration 按时间戳升序且可 revert、实体与 test/setup.ts 保持同步。
 * 漏登记只会表现为「某环境静默缺表」，这里把约束固化成测试。
 */

/** 扫描 src/entities/*.ts，取出每个文件 @Entity 装饰的导出类名（排除 index.ts 汇总文件） */
function collectEntityClasses(): string[] {
  const dir = path.resolve(__dirname, '../entities');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      // @Entity 与 export class 之间可能夹着 @Index / @Unique 等装饰器
      const match = content.match(/@Entity\([^)]*\)[\s\S]*?export class (\w+)/);
      if (!match) throw new Error(`实体文件 ${f} 未找到 @Entity 装饰的导出类`);
      return match[1];
    });
}

/** 生产注册的实体类名 */
function registeredEntityNames(): string[] {
  return (AppDataSource.options.entities as Function[]).map((e) => e.name);
}

/** test/setup.ts 里登记到测试 DataSource 的实体类名（静态解析，避免初始化测试库） */
function testSetupEntityNames(): string[] {
  const content = fs.readFileSync(path.resolve(__dirname, '../test/setup.ts'), 'utf-8');
  const names = new Set<string>();
  // 动态导入：const { X } = await import('../entities/X')
  for (const m of content.matchAll(/\{\s*(\w+)\s*\}\s*=\s*await import\(['"]\.\.\/entities\//g)) {
    names.add(m[1]);
  }
  // 顶部静态导入：import { X } from '../entities/X'（SubmissionSequence 走这条）
  for (const m of content.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*['"]\.\.\/entities\//g)) {
    names.add(m[1]);
  }
  return [...names];
}

describe('实体注册一致性', () => {
  const entityClasses = collectEntityClasses();

  it('src/entities 下每个实体类都在 entities 数组中登记', () => {
    const registered = new Set(registeredEntityNames());
    expect(entityClasses.filter((name) => !registered.has(name))).toEqual([]);
  });

  it('entities 数组没有重复登记，也没有 entities 目录之外的项', () => {
    const names = registeredEntityNames();
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    const declared = new Set(entityClasses);
    expect(names.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('新增实体同步登记到 test/setup.ts 的 loadEntities()', () => {
    const inTestSetup = new Set(testSetupEntityNames());
    expect(entityClasses.filter((name) => !inTestSetup.has(name))).toEqual([]);
  });
});

describe('migration 注册与可回滚', () => {
  const migrations = AppDataSource.options.migrations as Function[];

  it('按时间戳升序登记', () => {
    const stamps = migrations.map((m) => Number(m.name.match(/(\d{13})$/)?.[1] ?? NaN));
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps.every((n) => Number.isFinite(n))).toBe(true);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('每个 migration 都实现了 up / down（migration:revert 需要）', () => {
    for (const m of migrations) {
      const proto = m.prototype as { up?: unknown; down?: unknown };
      expect(typeof proto.up, `${m.name} 缺少 up`).toBe('function');
      expect(typeof proto.down, `${m.name} 缺少 down`).toBe('function');
    }
  });
});

describe('数据库类型', () => {
  it('默认使用 sqlite，且 DB_TYPE 只取 sqlite / postgres', () => {
    expect(databaseType).toBe((process.env.DB_TYPE || 'sqlite').toLowerCase());
    expect(['sqlite', 'postgres']).toContain(databaseType);
  });
});
