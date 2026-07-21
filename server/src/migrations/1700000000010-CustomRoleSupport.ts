import { MigrationInterface, QueryRunner } from 'typeorm';

/** 标记系统内置角色，为自定义角色的安全删除和重命名提供边界。 */
export class CustomRoleSupport1700000000010 implements MigrationInterface {
  name = 'CustomRoleSupport1700000000010';

  async up(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.driver.options.type === 'postgres';
    await queryRunner.query(isPg
      ? 'ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "isSystem" boolean NOT NULL DEFAULT false'
      : 'ALTER TABLE "roles" ADD COLUMN "isSystem" boolean NOT NULL DEFAULT 0');
    await queryRunner.query(
      `UPDATE "roles" SET "isSystem" = ${isPg ? 'true' : '1'} WHERE "name" IN ('admin', 'manager', 'group_leader', 'employee')`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "roles" DROP COLUMN "isSystem"');
  }
}
