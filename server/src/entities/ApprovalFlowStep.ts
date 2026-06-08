import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { ApprovalFlow } from './ApprovalFlow';
import { User } from './User';

/**
 * 审批流程步骤
 * stepType 定义该步骤由谁来审批：
 * - group_leader: 直属负责人
 * - parent_leader: 上级负责人
 * - dept_leader: 部门负责人
 * - module_se: 项目模块SE（需匹配项目+组）
 * - project_manager: 项目管理员
 * - custom: 自定义审批人（customApproverId）
 */
@Entity('approval_flow_steps')
export class ApprovalFlowStep {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ApprovalFlow, flow => flow.steps, { onDelete: 'CASCADE' })
  flow!: ApprovalFlow;

  @Column({ type: 'integer' })
  flowId!: number;

  /** 步骤顺序（从 1 开始） */
  @Column({ type: 'integer' })
  stepOrder!: number;

  /** 步骤类型 */
  @Column({ type: 'varchar', length: 50 })
  stepType!: 'group_leader' | 'parent_leader' | 'dept_leader' | 'module_se' | 'project_manager' | 'custom';

  /** 步骤显示名称 */
  @Column({ type: 'varchar', length: 100 })
  label!: string;

  /** 向上查找几级（仅 parent_leader 有效，默认 1） */
  @Column({ type: 'integer', default: 1 })
  parentLevel!: number;

  /** 自定义审批人ID（仅 stepType=custom 时有效） */
  @ManyToOne(() => User, { nullable: true })
  customApprover!: User | null;

  @Column({ type: 'integer', nullable: true })
  customApproverId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
