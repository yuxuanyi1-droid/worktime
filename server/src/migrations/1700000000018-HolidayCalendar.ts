import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 节假日日历表：
 * - date: YYYY-MM-DD 主键
 * - name: 节假日或调休说明
 * - isWorkday: false=法定休息日/节假日（加班按 holiday 计）；true=调休补班日（加班按 weekday 计）
 *
 * 幂等：使用 IF NOT EXISTS，兼容空库首次建表与已有库增量升级。
 */
export class HolidayCalendar1700000000018 implements MigrationInterface {
  name = 'HolidayCalendar1700000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "holidays" ("date" varchar(10) PRIMARY KEY, "name" varchar(100) NOT NULL, "isWorkday" boolean NOT NULL DEFAULT false)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "holidays"`);
  }
}
