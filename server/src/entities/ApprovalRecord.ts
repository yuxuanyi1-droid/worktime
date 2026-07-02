import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { Timesheet } from './Timesheet';
import { OvertimeApplication } from './OvertimeApplication';
import { WeeklyReport } from './WeeklyReport';

@Entity('approval_records')
export class ApprovalRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  targetType!: 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';

  @Column({ type: 'integer' })
  targetId!: number;

  @Column({ type: 'integer', nullable: true })
  instanceId!: number | null;

  @Column({ type: 'integer', nullable: true })
  taskId!: number | null;

  @Column({ type: 'integer' })
  approverId!: number;

  @Column({ type: 'varchar', length: 50 })
  approverName!: string;

  @Column({ type: 'varchar', length: 20 })
  action!: 'approve' | 'reject' | 'cc' | 'withdraw' | 'skip';

  @Column({ type: 'text', nullable: true })
  comment!: string;

  /** 审批步骤序号 */
  @Column({ type: 'integer', default: 1 })
  stepOrder!: number;

  /** 该步骤的类型标识 */
  @Column({ type: 'varchar', length: 50, nullable: true })
  stepType!: string;

  /** 该步骤的显示名称 */
  @Column({ type: 'varchar', length: 100, nullable: true })
  stepLabel!: string;

  @ManyToOne(() => Timesheet, timesheet => timesheet.approvalRecords, { nullable: true, onDelete: 'SET NULL' })
  timesheet!: Timesheet;

  @ManyToOne(() => OvertimeApplication, overtime => overtime.approvalRecords, { nullable: true, onDelete: 'SET NULL' })
  overtime!: OvertimeApplication;

  @ManyToOne(() => WeeklyReport, weeklyReport => weeklyReport.approvalRecords, { nullable: true, onDelete: 'SET NULL' })
  weeklyReport!: WeeklyReport;

  @CreateDateColumn()
  createdAt!: Date;
}
