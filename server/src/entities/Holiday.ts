import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * 节假日日历：
 * - date: YYYY-MM-DD，主键，唯一标识一天
 * - name: 节假日或调休说明（如「国庆节」「国庆调休补班」）
 * - isWorkday: false=法定休息日/节假日（加班计 holiday）；true=调休补班日（加班计 weekday）
 */
@Entity('holidays')
export class Holiday {
  @PrimaryColumn({ type: 'varchar', length: 10 })
  date!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'boolean', default: false })
  isWorkday!: boolean;
}
