import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 同一业务记录只能创建一个审批实例，为 Redis Streams 的至少一次投递提供数据库幂等兜底。
 * 新增唯一索引不改动已有列和数据；如历史库存在重复实例，先由一致性检查脚本确认并处理。
 */
export class ApprovalInstanceIdempotency1700000000005 implements MigrationInterface {
  name = 'ApprovalInstanceIdempotency1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_approval_instance_target"
      ON "approval_instances" ("targetType", "targetId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_approval_instance_target"`);
  }
}
