import { MigrationInterface, QueryRunner } from 'typeorm';

/** 一个本地用户对同一种登录方式最多绑定一个外部账号。 */
export class ExternalIdentityProviderConstraint1700000000016 implements MigrationInterface {
  name = 'ExternalIdentityProviderConstraint1700000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "user_external_identities"
          GROUP BY "userId", "provider"
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '同一用户存在多个同类型外部身份绑定，请人工核对后再执行迁移';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_ext_identity_user_provider"
      ON "user_external_identities" ("userId", "provider")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "uq_ext_identity_user_provider"');
  }
}
