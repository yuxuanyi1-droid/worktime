import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 数据完整性约束与索引（审查高危/中危修复的 DB 侧兜底）：
 * 1. submission_sequences 建表（幂等）—— 修复「synchronize=false 老库升级缺表，
 *    Redis 不可用时工时提交 nextSubmissionGroupIds 回退抛 QueryFailedError」。
 * 2. timesheets 部分唯一索引 (userId, projectId, date) WHERE 活跃 —— submitByRows
 *    并发提交的 DB 级兜底，防止同一用户+项目+日期出现两条活跃记录（重复工时/重复审批）。
 * 3. overtime_applications 部分唯一索引 (userId, date, overtimeType) WHERE 活跃 ——
 *    防止同日同类型重复加班（应用层另做同日 Σ≤1 天校验）。
 * 4. overtime_applications 业务索引（/my、/stats、报表按 snapshotId IN(...) 过滤的性能）。
 * 5. days/totalDays 列类型修正为 numeric(10,2)（仅 Postgres；0001 仅做了 CAST 未改类型；
 *    SQLite 不支持 ALTER COLUMN TYPE，其亲和类型经 0001 的 CAST 已正确，故跳过）。
 *
 * 幂等：全部使用 IF NOT EXISTS；唯一索引若已有存量重复活跃行会创建失败，
 * 届时需先清理重复数据（说明并发 bug 已实际发生）。
 */
export class DataIntegrityConstraints1700000000017 implements MigrationInterface {
  name = 'DataIntegrityConstraints1700000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. submission_sequences 建表（幂等）
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "submission_sequences" ("id" integer PRIMARY KEY, "currentValue" integer NOT NULL DEFAULT 0)`,
    );

    // 2. timesheets 并发提交兜底：同一用户+项目+日期仅允许一条「草稿/审批中」记录
    //    （谓词不含 approved：审批窗口期旧 approved 版本保留到新版本通过，见 0020 说明）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_timesheet_active_user_project_date"
       ON "timesheets" ("userId", "projectId", "date")
       WHERE "status" IN ('draft', 'submitted')`,
    );

    // 3. overtime_applications 同日同类型防重
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_overtime_active_user_date_type"
       ON "overtime_applications" ("userId", "date", "overtimeType")
       WHERE "status" IN ('draft', 'submitted', 'approved')`,
    );

    // 4. overtime_applications 业务索引
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_overtime_user_date" ON "overtime_applications" ("userId", "date")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_overtime_status_date" ON "overtime_applications" ("status", "date")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_overtime_dept_snapshot" ON "overtime_applications" ("departmentSnapshotId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_overtime_group_snapshot" ON "overtime_applications" ("groupSnapshotId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_overtime_project" ON "overtime_applications" ("projectId")`);

    // 5. days/totalDays 列类型修正为 numeric(10,2)（仅 Postgres）
    const dialect = (queryRunner.connection.options as { type?: string }).type;
    if (dialect === 'postgres') {
      const hasTimesheets = await queryRunner.hasTable('timesheets');
      if (hasTimesheets) {
        await queryRunner.query(`ALTER TABLE "timesheets" ALTER COLUMN "days" TYPE numeric(10,2) USING "days"::numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "overtime_applications" ALTER COLUMN "days" TYPE numeric(10,2) USING "days"::numeric(10,2)`);
        await queryRunner.query(`ALTER TABLE "weekly_reports" ALTER COLUMN "totalDays" TYPE numeric(10,2) USING "totalDays"::numeric(10,2)`);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dialect = (queryRunner.connection.options as { type?: string }).type;
    if (dialect === 'postgres') {
      await queryRunner.query(`ALTER TABLE "weekly_reports" ALTER COLUMN "totalDays" TYPE double precision USING "totalDays"::double precision`).catch(() => undefined);
      await queryRunner.query(`ALTER TABLE "overtime_applications" ALTER COLUMN "days" TYPE double precision USING "days"::double precision`).catch(() => undefined);
      await queryRunner.query(`ALTER TABLE "timesheets" ALTER COLUMN "days" TYPE double precision USING "days"::double precision`).catch(() => undefined);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_overtime_project"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_overtime_group_snapshot"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_overtime_dept_snapshot"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_overtime_status_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_overtime_user_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_overtime_active_user_date_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_timesheet_active_user_project_date"`);
    // submission_sequences 不自动删除（可能已有数据；如需清理另行处理）
  }
}
