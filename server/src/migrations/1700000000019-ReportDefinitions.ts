import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 自定义报表定义表：
 * - id: 主键（postgres=SERIAL / sqlite=integer AUTOINCREMENT）
 * - name: 报表名称
 * - ownerId: 创建者，外键 users(id) ON DELETE CASCADE
 * - config: 报表配置 JSON
 * - scope: 可见范围（private|group|department|public），默认 private
 * - scopeGroupId / scopeDepartmentId: 范围目标 id
 * - createdAt / updatedAt：按方言使用 TIMESTAMP DEFAULT now() 或 datetime DEFAULT (datetime('now'))
 *
 * 幂等：IF NOT EXISTS 兼容空库首次建表与已有库增量升级。
 * 与 HolidayCalendar1700000000018 一致，保持跨方言分支。
 */
export class ReportDefinitions1700000000019 implements MigrationInterface {
  name = 'ReportDefinitions1700000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const dialect = (queryRunner.connection.options as { type: string }).type;
    const isPostgres = dialect === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "report_definitions" (
          "id" SERIAL PRIMARY KEY,
          "name" varchar(100) NOT NULL,
          "ownerId" integer NOT NULL,
          "config" text NOT NULL,
          "scope" varchar(20) NOT NULL DEFAULT 'private',
          "scopeGroupId" integer,
          "scopeDepartmentId" integer,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
          CONSTRAINT "FK_report_definitions_owner" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "report_definitions" (
          "id" integer PRIMARY KEY AUTOINCREMENT,
          "name" varchar(100) NOT NULL,
          "ownerId" integer NOT NULL,
          "config" text NOT NULL,
          "scope" varchar(20) NOT NULL DEFAULT 'private',
          "scopeGroupId" integer,
          "scopeDepartmentId" integer,
          "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
          "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
          "ownerId" integer REFERENCES "users"("id") ON DELETE CASCADE
        )
      `);
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_report_definition_owner" ON "report_definitions" ("ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_report_definition_scope" ON "report_definitions" ("scope")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "report_definitions"`);
  }
}
