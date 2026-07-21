import { MigrationInterface, QueryRunner } from 'typeorm';

const removedCodes = [
  'timesheet:withdraw:self',
  'timesheet:view:project',
  'timesheet:approve:assigned',
  'timesheet:export',
  'overtime:withdraw:self',
  'overtime:approve:assigned',
  'overtime:export',
  'weekly_report:update:self',
  'weekly_report:approve:assigned',
  'approval:view:all',
  'project:view:self',
  'permission_request:approve:assigned',
];

/** 删除没有独立控制点的权限；备份迁移数据以支持完整回滚。 */
export class RemoveUnusedPermissions1700000000011 implements MigrationInterface {
  name = 'RemoveUnusedPermissions1700000000011';

  async up(queryRunner: QueryRunner): Promise<void> {
    const params = removedCodes.map((_, index) => `$${index + 1}`).join(', ');
    const sqliteParams = removedCodes.map(() => '?').join(', ');
    const placeholders = queryRunner.connection.driver.options.type === 'postgres' ? params : sqliteParams;

    await queryRunner.query(
      `CREATE TABLE "migration_0011_removed_permissions" AS
       SELECT * FROM "permissions" WHERE "code" IN (${placeholders})`,
      removedCodes,
    );
    await queryRunner.query(
      `CREATE TABLE "migration_0011_removed_role_permissions" AS
       SELECT rp.* FROM "role_permissions" rp
       INNER JOIN "permissions" p ON p."id" = rp."permissionId"
       WHERE p."code" IN (${placeholders})`,
      removedCodes,
    );
    await queryRunner.query(
      `DELETE FROM "role_permissions" WHERE "permissionId" IN (
        SELECT "id" FROM "permissions" WHERE "code" IN (${placeholders})
      )`,
      removedCodes,
    );
    await queryRunner.query(
      `UPDATE "permission_requests" SET "permissionId" = NULL WHERE "permissionCode" IN (${placeholders})`,
      removedCodes,
    );
    await queryRunner.query(
      `UPDATE "user_permission_grants" SET "permissionId" = NULL WHERE "permissionCode" IN (${placeholders})`,
      removedCodes,
    );
    await queryRunner.query(`DELETE FROM "permissions" WHERE "code" IN (${placeholders})`, removedCodes);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.driver.options.type === 'postgres';
    const placeholders = removedCodes.map((_, index) => isPg ? `$${index + 1}` : '?').join(', ');
    await queryRunner.query(
      `INSERT INTO "permissions" SELECT * FROM "migration_0011_removed_permissions"`,
    );
    await queryRunner.query(
      `INSERT INTO "role_permissions" SELECT * FROM "migration_0011_removed_role_permissions"`,
    );
    await queryRunner.query(
      `UPDATE "permission_requests"
       SET "permissionId" = (SELECT p."id" FROM "permissions" p WHERE p."code" = "permission_requests"."permissionCode")
       WHERE "permissionCode" IN (${placeholders})`,
      removedCodes,
    );
    await queryRunner.query(
      `UPDATE "user_permission_grants"
       SET "permissionId" = (SELECT p."id" FROM "permissions" p WHERE p."code" = "user_permission_grants"."permissionCode")
       WHERE "permissionCode" IN (${placeholders})`,
      removedCodes,
    );
    await queryRunner.query('DROP TABLE "migration_0011_removed_role_permissions"');
    await queryRunner.query('DROP TABLE "migration_0011_removed_permissions"');
  }
}
