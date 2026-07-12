import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 会签支持：给 approval_flow_steps 加 requireAllApprovers 列。
 * - false（默认）：或签，任一审批人通过即推进
 * - true：会签，本步骤所有审批人都通过才推进
 *
 * 调试期 ensureSchema 的 synchronize 会根据实体自动建列；
 * 此 migration 作为版本记录 + 老库升级路径。
 */
export class CountersignSupport1700000000002 implements MigrationInterface {
  name = 'CountersignSupport1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 catch 兜底（列已存在则跳过）
    try {
      await queryRunner.query(`ALTER TABLE "approval_flow_steps" ADD COLUMN "requireAllApprovers" boolean NOT NULL DEFAULT false`);
    } catch {
      // 列已存在，跳过
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`ALTER TABLE "approval_flow_steps" DROP COLUMN "requireAllApprovers"`);
    } catch {
      // 列不存在，跳过
    }
  }
}
