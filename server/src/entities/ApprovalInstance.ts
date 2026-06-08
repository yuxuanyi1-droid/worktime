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
}

@Entity('approval_instances')
@Index(['targetType', 'targetId'])
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

  @Column({ type: 'datetime' })
  submittedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  finishedAt!: Date | null;

  @OneToMany(() => ApprovalTask, task => task.instance)
  tasks!: ApprovalTask[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
