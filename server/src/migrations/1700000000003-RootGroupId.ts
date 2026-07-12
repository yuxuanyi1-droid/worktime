import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修改链根分组：给 timesheets 加 rootGroupId 列。
 * 同一条工时的所有版本（原始提交 v1 → 修改 v2 → 修改 v3…）共享此值，
 * 用于一次性查询整条修改链，避免逐级回查 previousGroupId。
 *
 * 首次提交时 rootGroupId = 自身 submissionGroupId；
 * 修改时 rootGroupId 继承自前驱版本的 rootGroupId。
 *
 * 调试期 ensureSchema 的 synchronize 会根据实体自动建列；
 * 此 migration 作为版本记录 + 老库升级路径，并补建索引。
 */
export class RootGroupId1700000000003 implements MigrationInterface {
  name = 'RootGroupId1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 catch 兜底（列已存在则跳过）
    try {
      await queryRunner.query(`ALTER TABLE "timesheets" ADD COLUMN "rootGroupId" integer`);
    } catch {
      // 列已存在，跳过
    }
    // 回填：rootGroupId 为空但 submissionGroupId 非空的历史记录，以自身 submissionGroupId 为根
    try {
      await queryRunner.query(`UPDATE "timesheets" SET "rootGroupId" = "submissionGroupId" WHERE "rootGroupId" IS NULL AND "submissionGroupId" IS NOT NULL`);
    } catch {
      // 忽略回填失败
    }
    try {
      await queryRunner.query(`CREATE INDEX "idx_timesheet_root_group" ON "timesheets" ("rootGroupId")`);
    } catch {
      // 索引已存在，跳过
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`DROP INDEX "idx_timesheet_root_group"`);
    } catch {
      // 忽略
    }
    try {
      await queryRunner.query(`ALTER TABLE "timesheets" DROP COLUMN "rootGroupId"`);
    } catch {
      // 列不存在，跳过
    }
  }
}
