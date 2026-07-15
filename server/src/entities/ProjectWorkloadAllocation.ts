import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Unique, Index } from 'typeorm';
import { Project } from './Project';
import { Group } from './Group';

/**
 * 项目工时配额（按组配置，单位人/天）
 *
 * 每个项目可为每个组配置一个工时配额。工时审批时动态计算该组在该项目的已消耗工时
 * （submitted + approved），与配额对比，超额时在审批单中向审批人展示警告（不拦截提交）。
 *
 * 唯一约束 (projectId, groupId)：每个项目每组一条配额。未配置 = 不限制。
 */
@Entity('project_workload_allocations')
@Unique('uq_project_allocation_group', ['projectId', 'groupId'])
@Index('idx_project_allocation_project', ['projectId'])
export class ProjectWorkloadAllocation {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Project, project => project.workloadAllocations)
  project!: Project;

  @Column({ type: 'integer' })
  projectId!: number;

  /** 配额对应的组 */
  @ManyToOne(() => Group)
  group!: Group;

  @Column({ type: 'integer' })
  groupId!: number;

  /** 组名称（冗余，方便展示） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  groupName!: string;

  /** 工时配额（人/天），与 timesheets.days 同单位 */
  @Column({ type: 'numeric', precision: 10, scale: 2 })
  allocation!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
