import { MigrationInterface, QueryRunner } from 'typeorm';

export class ApprovalPendingPaginationIndex1700000000007 implements MigrationInterface {
  name = 'ApprovalPendingPaginationIndex1700000000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_approval_tasks_status_updated_at" ON "approval_tasks" ("status", "updatedAt")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_approval_tasks_status_updated_at"');
  }
}
