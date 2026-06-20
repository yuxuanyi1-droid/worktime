import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 工时精度修正 + 关键索引：
 * 1. hours/totalHours 由 float 改为 numeric(10,2)，消除累计精度误差
 *    （SQLite 无独立 numeric，实际是 NUMERIC 亲和，CAST 保证数值正确）
 * 2. timesheets 补建高频查询索引
 *
 * 调试期：ensureSchema 的 synchronize 会根据实体重建表结构（含新类型/索引），
 * 此 migration 作为版本记录 + 老库（synchronize=false）升级路径。
 */
export class PrecisionAndIndexes1700000000001 implements MigrationInterface {
  name = 'PrecisionAndIndexes1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. hours/totalHours 类型修正（SQLite 用 CAST 转 numeric 亲和，幂等）
    await queryRunner.query(`UPDATE timesheets SET hours = CAST(hours AS REAL) WHERE 1=1`);
    await queryRunner.query(`UPDATE overtime_applications SET hours = CAST(hours AS REAL) WHERE 1=1`);
    await queryRunner.query(`UPDATE weekly_reports SET totalHours = CAST(totalHours AS REAL) WHERE 1=1`);

    // 2. timesheets 索引（IF NOT EXISTS 幂等，synchronize 已建的不会重复）
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_timesheet_user_date" ON "timesheets" ("userId", "date")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_timesheet_user_status" ON "timesheets" ("userId", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_timesheet_submission_group" ON "timesheets" ("submissionGroupId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_timesheet_date_status" ON "timesheets" ("date", "status")`);

    // 3. notifications 索引（按用户查询/未读数高频）
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_user_created" ON "notifications" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_notification_user_read" ON "notifications" ("userId", "isRead")`);

    // 4. audit_logs 索引（审计查询按 user/action/时间）
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_audit_user_created" ON "audit_logs" ("userId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_audit_action_target" ON "audit_logs" ("action", "target")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_audit_created" ON "audit_logs" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_action_target"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_user_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_user_read"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notification_user_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_timesheet_date_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_timesheet_submission_group"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_timesheet_user_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_timesheet_user_date"`);
  }
}
