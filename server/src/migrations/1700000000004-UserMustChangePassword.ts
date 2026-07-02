import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * users 表新增 mustChangePassword 列。
 * 用于强制首次登录改密 / 管理员重置密码后强制改密。
 *
 * 注意：schema 权威源是 entity 元数据，空库首次建表由 ensureSchema 的 synchronize 负责；
 * 本 migration 是老库（已有 users 表）的升级路径，ALTER TABLE ADD COLUMN 幂等。
 */
export class UserMustChangePassword1700000000004 implements MigrationInterface {
  name = 'UserMustChangePassword1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 try/catch 兜底（列已存在则跳过）
    try {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "mustChangePassword" boolean NOT NULL DEFAULT (0)`);
    } catch {
      // 列已存在，跳过
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 DROP COLUMN（3.35+ 支持，但为兼容性这里也 try/catch）
    try {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "mustChangePassword"`);
    } catch {
      // 列不存在，跳过
    }
  }
}
