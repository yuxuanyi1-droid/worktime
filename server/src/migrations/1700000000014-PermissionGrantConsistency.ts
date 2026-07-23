import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 权限申请与授权的一致性约束：
 * - 同一用户、权限、范围只能有一条审批中的申请；
 * - 同一用户、权限、范围只能有一条生效授权。
 *
 * 迁移不会擅自改变已有审批或授权状态；若发现历史重复数据，会在建索引前明确失败，
 * 由管理员核对业务含义后处理。这样 down 只需删除索引即可完整回滚本次变更。
 */
export class PermissionGrantConsistency1700000000014 implements MigrationInterface {
  name = 'PermissionGrantConsistency1700000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 自动把重复审批标成撤回会篡改业务历史，因此只做无损前置检查。
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "permission_requests"
          WHERE "status" = 'submitted'
          GROUP BY "applicantId", "permissionCode", "scopeType", COALESCE("scopeId", 0)
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '存在同用户、权限和范围的重复审批中权限申请，请人工核对后再执行迁移';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "user_permission_grants"
          WHERE "status" = 'active'
          GROUP BY "userId", "permissionCode", "scopeType", COALESCE("scopeId", 0)
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '存在同用户、权限和范围的重复生效授权，请人工核对后再执行迁移';
        END IF;
      END $$
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_permission_requests_submitted_scope"
      ON "permission_requests" (
        "applicantId", "permissionCode", "scopeType", COALESCE("scopeId", 0)
      )
      WHERE "status" = 'submitted'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_permission_grants_active_scope"
      ON "user_permission_grants" (
        "userId", "permissionCode", "scopeType", COALESCE("scopeId", 0)
      )
      WHERE "status" = 'active'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "uq_user_permission_grants_active_scope"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_permission_requests_submitted_scope"');
  }
}
