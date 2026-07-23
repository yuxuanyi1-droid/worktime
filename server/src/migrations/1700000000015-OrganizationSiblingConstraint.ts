import { MigrationInterface, QueryRunner } from 'typeorm';

/** 同一部门、同一父级下的分组名称必须唯一，数据库层兜住管理端和 JIT 并发创建竞态。 */
export class OrganizationSiblingConstraint1700000000015 implements MigrationInterface {
  name = 'OrganizationSiblingConstraint1700000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "groups"
          GROUP BY COALESCE("departmentId", 0), COALESCE("parentId", 0), "name"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '同一部门和父级下存在重名分组，请人工核对后再执行迁移';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_group_department_parent_name"
      ON "groups" (COALESCE("departmentId", 0), COALESCE("parentId", 0), "name")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "uq_group_department_parent_name"');
  }
}
