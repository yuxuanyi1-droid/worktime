import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany, Index } from 'typeorm';
import { User } from './User';
import { Project } from './Project';
import { ApprovalRecord } from './ApprovalRecord';
import { ApprovalFlow } from './ApprovalFlow';

@Entity('timesheets')
@Index('idx_timesheet_user_date', ['userId', 'date'])
@Index('idx_timesheet_user_status', ['userId', 'status'])
@Index('idx_timesheet_submission_group', ['submissionGroupId'])
@Index('idx_timesheet_root_group', ['rootGroupId'])
@Index('idx_timesheet_date_status', ['date', 'status'])
export class Timesheet {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, user => user.timesheets)
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

  @ManyToOne(() => Project, project => project.timesheets)
  project!: Project;

  @Column({ type: 'integer' })
  projectId!: number;

  @Column({ type: 'varchar', length: 20 })
  date!: string; // YYYY-MM-DD

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  hours!: number;

  @Column({ type: 'text', nullable: true })
  description!: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: 'draft' | 'submitted' | 'approved' | 'rejected' | 'deprecated' | 'withdrawn';

  /** 当前审批步骤（0=未提交，1+=审批中第N步） */
  @Column({ type: 'integer', default: 0 })
  currentStep!: number;

  /** 使用的审批流程ID */
  @ManyToOne(() => ApprovalFlow, { nullable: true })
  approvalFlow!: ApprovalFlow | null;

  @Column({ type: 'integer', nullable: true })
  approvalFlowId!: number | null;

  @Column({ type: 'integer', nullable: true })
  approvalInstanceId!: number | null;

  /** 总审批步骤数 */
  @Column({ type: 'integer', default: 0 })
  totalSteps!: number;

  /** 提交分组ID：同一行（项目+周）的所有天共享此ID */
  @Column({ type: 'integer', nullable: true })
  submissionGroupId!: number | null;

  /** 修改前的原始提交分组ID（用于追溯修改链，关联原审批记录） */
  @Column({ type: 'integer', nullable: true })
  previousGroupId!: number | null;

  /** 修改链的根提交分组ID：同一条工时的所有版本（含原始提交）共享此值，
   *  用于一次性查询整条修改链（v1→v2→v3…）。首次提交时 = 自身 submissionGroupId。 */
  @Column({ type: 'integer', nullable: true })
  rootGroupId!: number | null;

  @OneToMany(() => ApprovalRecord, record => record.timesheet)
  approvalRecords!: ApprovalRecord[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
