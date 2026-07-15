import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, Unique, Index } from 'typeorm';
import { User } from './User';
import { ApprovalRecord } from './ApprovalRecord';
import { ApprovalFlow } from './ApprovalFlow';

@Entity('weekly_reports')
@Unique('uq_weekly_report_user_week', ['userId', 'weekStart'])
@Index('idx_weekly_report_user', ['userId'])
export class WeeklyReport {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, user => user.weeklyReports)
  user!: User;

  @Column({ type: 'integer' })
  userId!: number;

  @Column({ type: 'varchar', length: 20 })
  weekStart!: string;

  @Column({ type: 'varchar', length: 20 })
  weekEnd!: string;

  @Column({ type: 'text', nullable: true })
  content!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  totalDays!: number;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';

  @Column({ type: 'integer', default: 0 })
  currentStep!: number;

  @ManyToOne(() => ApprovalFlow, { nullable: true })
  approvalFlow!: ApprovalFlow | null;

  @Column({ type: 'integer', nullable: true })
  approvalFlowId!: number | null;

  @Column({ type: 'integer', nullable: true })
  approvalInstanceId!: number | null;

  @Column({ type: 'integer', default: 0 })
  totalSteps!: number;

  @OneToMany(() => ApprovalRecord, record => record.weeklyReport)
  approvalRecords!: ApprovalRecord[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
