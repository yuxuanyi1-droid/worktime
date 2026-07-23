import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 保留每次审批的独立实例，同时只允许同一业务记录存在一个进行中的实例。
 * 旧索引约束了全部历史实例，会导致驳回或撤回后的记录无法重新提交。
 */
export class ApprovalInstanceResubmission1700000000012 implements MigrationInterface {
  name = 'ApprovalInstanceResubmission1700000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_approval_instance_target"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_approval_instance_active_target"
      ON "approval_instances" ("targetType", "targetId")
      WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 使用新语义后可能已经积累多个历史实例；旧约束无法无损容纳这些数据。
    // 在改索引前主动终止，让管理员保留新 schema，而不是删除审批历史或留下无约束状态。
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "approval_instances"
          GROUP BY "targetType", "targetId"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '同一业务记录已存在多个历史审批实例，无法无损恢复旧唯一约束';
        END IF;
      END $$
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_approval_instance_active_target"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_approval_instance_target"
      ON "approval_instances" ("targetType", "targetId")
    `);
  }
}
