import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './User';
import { ApprovalInstance } from './ApprovalInstance';
import { ApprovalStepType, ApprovalTargetType } from './ApprovalFlowVersion';

export type ApprovalTaskStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped' | 'withdrawn';
export type ApprovalTaskAction = 'approve' | 'reject' | 'skip' | 'withdraw';

@Entity('approval_tasks')
@Index(['approverId', 'status'])
@Index(['status', 'updatedAt'])
@Index(['targetType', 'targetId'])
@Index(['instanceId', 'stepOrder'])
export class ApprovalTask {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ApprovalInstance, instance => instance.tasks, { onDelete: 'CASCADE' })
  instance!: ApprovalInstance;

  @Column({ type: 'integer' })
  instanceId!: number;

  @Column({ type: 'varchar', length: 50 })
  targetType!: ApprovalTargetType;

  @Column({ type: 'integer' })
  targetId!: number;

  @Column({ type: 'integer' })
  stepOrder!: number;

  @Column({ type: 'integer' })
  sourceStepOrder!: number;

  @Column({ type: 'varchar', length: 50 })
  stepType!: ApprovalStepType;

  @Column({ type: 'varchar', length: 100 })
  stepLabel!: string;

  @ManyToOne(() => User, { nullable: true })
  approver!: User | null;

  @Column({ type: 'integer' })
  approverId!: number;

  @Column({ type: 'varchar', length: 50 })
  approverName!: string;

  @Column({ type: 'varchar', length: 20, default: 'waiting' })
  status!: ApprovalTaskStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  action!: ApprovalTaskAction | null;

  @Column({ type: 'integer', nullable: true })
  actedById!: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  actedByName!: string | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  actedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
