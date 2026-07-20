import { MigrationInterface, QueryRunner } from 'typeorm';

/** 为外部身份保存 IdP 工号，供 TT 等企业内部服务寻址。 */
export class ExternalIdentityEmployeeId1700000000008 implements MigrationInterface {
  name = 'ExternalIdentityEmployeeId1700000000008';

  async up(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.driver.options.type === 'postgres';
    if (isPg) {
      await queryRunner.query(
        'ALTER TABLE "user_external_identities" ADD COLUMN IF NOT EXISTS "employeeId" varchar(100)',
      );
      return;
    }
    await queryRunner.query(
      'ALTER TABLE "user_external_identities" ADD COLUMN "employeeId" varchar(100)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "user_external_identities" DROP COLUMN "employeeId"',
    );
  }
}
