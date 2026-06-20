import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ApprovalFlow } from './ApprovalFlow';

export type ApprovalTargetType = 'timesheet' | 'overtime' | 'weekly_report' | 'permission_request';
export type ApprovalStepType = 'group_leader' | 'parent_leader' | 'dept_leader' | 'module_se' | 'project_manager' | 'custom';

export interface ApprovalFlowStepSnapshot {
  stepOrder: number;
  stepType: ApprovalStepType;
  label: string;
  parentLevel: number;
  customApproverId: number | null;
  requireAllApprovers?: boolean;
}

@Entity('approval_flow_versions')
@Index(['flowId', 'version'], { unique: true })
export class ApprovalFlowVersion {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ApprovalFlow, { nullable: true, onDelete: 'CASCADE' })
  flow!: ApprovalFlow | null;

  @Column({ type: 'integer', nullable: true })
  flowId!: number | null;

  @Column({ type: 'varchar', length: 100 })
  flowName!: string;

  @Column({ type: 'varchar', length: 50 })
  type!: ApprovalTargetType;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'simple-json' })
  steps!: ApprovalFlowStepSnapshot[];

  @CreateDateColumn()
  createdAt!: Date;
}
