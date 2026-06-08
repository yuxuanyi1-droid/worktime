import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { ApprovalFlowStep } from './ApprovalFlowStep';

/**
 * 审批流程模板
 * 管理员可配置不同类型（工时/加班/周报）的审批层级
 */
@Entity('approval_flows')
export class ApprovalFlow {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** 适用类型：timesheet / overtime / weekly_report */
  @Column({ type: 'varchar', length: 50 })
  type!: 'timesheet' | 'overtime' | 'weekly_report';

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string;

  /** 是否为该类型的默认流程 */
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  /** 是否启用 */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @OneToMany(() => ApprovalFlowStep, step => step.flow, { cascade: true })
  steps!: ApprovalFlowStep[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
