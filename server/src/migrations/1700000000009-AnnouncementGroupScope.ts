import { MigrationInterface, QueryRunner } from 'typeorm';

/** 为公告增加分组范围；旧公告保持原范围不变。 */
export class AnnouncementGroupScope1700000000009 implements MigrationInterface {
  name = 'AnnouncementGroupScope1700000000009';

  async up(queryRunner: QueryRunner): Promise<void> {
    const isPg = queryRunner.connection.driver.options.type === 'postgres';
    await queryRunner.query(isPg
      ? 'ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "targetGroupId" integer'
      : 'ALTER TABLE "announcements" ADD COLUMN "targetGroupId" integer');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "announcements" DROP COLUMN "targetGroupId"');
  }
}
