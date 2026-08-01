import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 审批窗口期版本化（2026-08 审查修复）：
 *
 * 1. timesheets 唯一索引谓词变更：
 *    uq_timesheet_active_user_project_date 原谓词含 approved，导致「旧版本已通过 + 新版本
 *    提交审批中」无法并存——submitByRows 只能提交时立即废弃旧 approved，报表/周报在
 *    新版本审批窗口期内归零。现改为仅约束 draft/submitted：
 *    - 审批窗口期：v1(approved) 与 v2(submitted) 并存，报表继续统计 v1；
 *    - v2 通过时由 approvalService 按 rootGroupId 整链废弃 v1（同一事务）；
 *    - 并发重复提交仍被 (draft, submitted) 唯一索引在 DB 层兜底。
 *    应用层 create/batchCreate/update 另做「同项目同日期已存在草稿/审批中」友好校验。
 *
 * 2. approval_records 抄送唯一索引：
 *    cc 是 check-then-insert，实体无唯一约束时并发抄送会插入重复记录（重复通知）。
 *    部分唯一索引 (targetType, targetId, approverId) WHERE action='cc' 作为 DB 级兜底，
 *    现有 isUniqueViolation 捕获即生效。
 *
 * 幂等：先 DROP 旧索引再 CREATE（唯一索引不能原地改谓词）；
 * 老库已执行 0017（旧谓词）→ DROP 后按新谓词重建；新库 0017 已是新谓词 → DROP IF EXISTS 无操作后重建。
 */
export class ApprovalWindowVersioning1700000000020 implements MigrationInterface {
  name = 'ApprovalWindowVersioning1700000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. timesheets 活跃唯一索引改谓词（去掉 approved）
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_timesheet_active_user_project_date"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_timesheet_active_user_project_date"
       ON "timesheets" ("userId", "projectId", "date")
       WHERE "status" IN ('draft', 'submitted')`,
    );

    // 2. approval_records 抄送去重兜底（仅 action='cc'；若历史已有重复 cc 数据会创建失败，
    //    说明并发 bug 已实际发生，需先清理重复行再执行本迁移）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_approval_record_cc_recipient"
       ON "approval_records" ("targetType", "targetId", "approverId")
       WHERE "action" = 'cc'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_approval_record_cc_recipient"`);
    // 回滚到旧谓词（含 approved），与新库 0017 的历史行为一致
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_timesheet_active_user_project_date"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_timesheet_active_user_project_date"
       ON "timesheets" ("userId", "projectId", "date")
       WHERE "status" IN ('draft', 'submitted', 'approved')`,
    );
  }
}
