import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany } from 'typeorm';
import { User } from './User';
import { ApprovalRecord } from './ApprovalRecord';
import { ApprovalFlow } from './ApprovalFlow';

@Entity('weekly_reports')
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

  @Column({ type: 'float', default: 0 })
  totalHours!: number;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: 'draft' | 'submitted' | 'approved' | 'rejected';

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
