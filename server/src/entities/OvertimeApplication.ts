import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany } from 'typeorm';
import { User } from './User';
import { Project } from './Project';
import { ApprovalRecord } from './ApprovalRecord';
import { ApprovalFlow } from './ApprovalFlow';

export type OvertimeType = 'weekend' | 'holiday' | 'weekday';

@Entity('overtime_applications')
export class OvertimeApplication {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, user => user.overtimeApplications)
  user!: User;

  @Column({ type: 'integer' })
  userId!: number;

  @Column({ type: 'integer', nullable: true })
  departmentSnapshotId!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  departmentSnapshotName!: string | null;

  @Column({ type: 'integer', nullable: true })
  groupSnapshotId!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  groupSnapshotName!: string | null;

  @Column({ type: 'integer', nullable: true })
  projectId!: number | null;

  @ManyToOne(() => Project, { nullable: true })
  project!: Project | null;

  @Column({ type: 'varchar', length: 20 })
  date!: string; // YYYY-MM-DD

  @Column({ type: 'varchar', length: 20 })
  overtimeType!: OvertimeType;

  @Column({ type: 'float' })
  hours!: number;

  @Column({ type: 'text', nullable: true })
  reason!: string;

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

  @OneToMany(() => ApprovalRecord, record => record.overtime)
  approvalRecords!: ApprovalRecord[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
