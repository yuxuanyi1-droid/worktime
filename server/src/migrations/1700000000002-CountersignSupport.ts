import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

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
    const table = await queryRunner.getTable('approval_flow_steps');
    if (!table) return;
    if (table.findColumnByName('requireAllApprovers')) return;
    await queryRunner.addColumn(
      'approval_flow_steps',
      new TableColumn({
        name: 'requireAllApprovers',
        type: 'boolean',
        default: false,
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('approval_flow_steps');
    if (!table?.findColumnByName('requireAllApprovers')) return;
    await queryRunner.dropColumn('approval_flow_steps', 'requireAllApprovers');
  }
}
