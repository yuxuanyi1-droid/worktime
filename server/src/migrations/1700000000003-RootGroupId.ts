import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * 修改链根分组：给 timesheets 加 rootGroupId 列。
 * 同一条工时的所有版本（原始提交 v1 → 修改 v2 → 修改 v3…）共享此值，
 * 用于一次性查询整条修改链，避免逐级回查 previousGroupId。
 *
 * 首次提交时 rootGroupId = 自身 submissionGroupId；
 * 修改时 rootGroupId 继承自前驱版本的 rootGroupId。
 *
 * 调试期 ensureSchema 的 synchronize 会根据实体自动建列；
 * 此 migration 作为版本记录 + 老库升级路径，并补建索引。
 */
export class RootGroupId1700000000003 implements MigrationInterface {
  name = 'RootGroupId1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('timesheets');
    if (!table) return;

    if (!table.findColumnByName('rootGroupId')) {
      await queryRunner.addColumn(
        'timesheets',
        new TableColumn({
          name: 'rootGroupId',
          type: 'integer',
          isNullable: true,
        }),
      );
    }

    await queryRunner.query(
      `UPDATE "timesheets" SET "rootGroupId" = "submissionGroupId" WHERE "rootGroupId" IS NULL AND "submissionGroupId" IS NOT NULL`,
    );

    const hasIndex = table.indices.some((i) => i.name === 'idx_timesheet_root_group')
      || (await queryRunner.getTable('timesheets'))?.indices.some((i) => i.name === 'idx_timesheet_root_group');
    if (!hasIndex) {
      try {
        await queryRunner.createIndex(
          'timesheets',
          new TableIndex({
            name: 'idx_timesheet_root_group',
            columnNames: ['rootGroupId'],
          }),
        );
      } catch {
        // 索引已存在
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('timesheets');
    if (!table) return;
    try {
      await queryRunner.dropIndex('timesheets', 'idx_timesheet_root_group');
    } catch {
      // ignore
    }
    if (table.findColumnByName('rootGroupId')) {
      await queryRunner.dropColumn('timesheets', 'rootGroupId');
    }
  }
}
