import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 登录失败计数表：把原先进程内 Map 的登录失败计数持久化到数据库，
 * 支持多实例部署（多实例共享同一份计数，避免轮询绕过锁定）。
 *
 * 调试期 ensureSchema 的 synchronize 会根据实体自动建表；
 * 此 migration 作为版本记录 + 老库升级路径。
 */
export class LoginAttemptTable1700000000003 implements MigrationInterface {
  name = 'LoginAttemptTable1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 CREATE TABLE IF NOT EXISTS 在所有版本一致，用 catch 兜底（表已存在则跳过）
    try {
      await queryRunner.query(`
        CREATE TABLE "login_attempts" (
          "loginKey"      varchar(255) NOT NULL PRIMARY KEY,
          "failCount"     integer NOT NULL DEFAULT (0),
          "lockedUntil"   bigint,
          "lastFailedAt"  bigint NOT NULL
        )
      `);
      await queryRunner.query(`CREATE INDEX "idx_login_attempts_last_failed" ON "login_attempts" ("lastFailedAt")`);
    } catch {
      // 表已存在，跳过
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`DROP INDEX "idx_login_attempts_last_failed"`);
    } catch {
      // 索引不存在，跳过
    }
    try {
      await queryRunner.query(`DROP TABLE "login_attempts"`);
    } catch {
      // 表不存在，跳过
    }
  }
}
