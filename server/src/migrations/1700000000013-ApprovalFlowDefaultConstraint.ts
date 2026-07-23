import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 每种业务类型只允许一个默认审批流程。
 * 若历史数据中已有重复默认项，迁移会明确终止，避免擅自改变正在使用的审批配置。
 */
export class ApprovalFlowDefaultConstraint1700000000013 implements MigrationInterface {
  name = 'ApprovalFlowDefaultConstraint1700000000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "approval_flows"
          WHERE "isDefault" = true
          GROUP BY "type"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '同一业务类型存在多个默认审批流程，请人工确认后再执行迁移';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_approval_flow_default_type"
      ON "approval_flows" ("type")
      WHERE "isDefault" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "uq_approval_flow_default_type"');
  }
}
