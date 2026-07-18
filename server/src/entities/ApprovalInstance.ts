import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './User';
import { ApprovalFlowVersion, ApprovalStepType, ApprovalTargetType } from './ApprovalFlowVersion';
import { ApprovalTask } from './ApprovalTask';

export type ApprovalInstanceStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ApprovalInstanceStepSnapshot {
  stepOrder: number;
  sourceStepOrder: number;
  stepType: ApprovalStepType;
  label: string;
  approvers: { id: number; name: string }[];
  requireAllApprovers?: boolean;
}

@Entity('approval_instances')
@Index('uq_approval_instance_target', ['targetType', 'targetId'], { unique: true })
@Index(['applicantId', 'status'])
export class ApprovalInstance {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  targetType!: ApprovalTargetType;

  @Column({ type: 'integer' })
  targetId!: number;

  @ManyToOne(() => User, { nullable: true })
  applicant!: User | null;

  @Column({ type: 'integer' })
  applicantId!: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: ApprovalInstanceStatus;

  @Column({ type: 'integer', nullable: true })
  currentStepOrder!: number | null;

  @Column({ type: 'integer', default: 0 })
  totalSteps!: number;

  @Column({ type: 'integer', nullable: true })
  flowId!: number | null;

  @ManyToOne(() => ApprovalFlowVersion, { nullable: true, onDelete: 'SET NULL' })
  flowVersion!: ApprovalFlowVersion | null;

  @Column({ type: 'integer', nullable: true })
  flowVersionId!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  flowName!: string | null;

  @Column({ type: 'integer', nullable: true })
  flowVersionNumber!: number | null;

  @Column({ type: 'simple-json' })
  stepsSnapshot!: ApprovalInstanceStepSnapshot[];

  /**
   * 工时配额快照（仅 timesheet 类型）：
   * 提交时计算并冻结，审批通过/驳回后仍展示此快照（不再动态更新）。
   * null = 未配置配额 或 非 timesheet 类型。
   */
  @Column({ type: 'simple-json', nullable: true })
  quotaSnapshot!: {
    total: number;
    consumed: number;
    remaining: number;
    submitted: number;
    exceeded: boolean;
    groupName?: string;
  } | null;

  @Column({ type: 'timestamp' })
  submittedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt!: Date | null;

  @OneToMany(() => ApprovalTask, task => task.instance)
  tasks!: ApprovalTask[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
