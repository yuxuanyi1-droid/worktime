import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  Index,
} from 'typeorm';
import { User } from './User';

/**
 * 自定义报表定义：
 * - name: 报表名称（最长 100 字符）
 * - ownerId: 创建者，关联 User，删除用户时级联删除其报表定义
 * - config: 报表配置 JSON 字符串（结构见 ReportQueryConfig）
 * - scope: 可见范围
 *   - private：仅创建者可见
 *   - group：创建者所在分组可见（scopeGroupId 指定分组）
 *   - department：创建者所在部门可见（scopeDepartmentId 指定部门）
 *   - public：全员可见
 * - scopeGroupId / scopeDepartmentId：scope 为 group / department 时的目标范围
 *
 * 与 Holiday 一样采用显式表名，避免 TypeORM 默认复数推断差异。
 */
export type ReportDefinitionScope = 'private' | 'group' | 'department' | 'public';

@Entity('report_definitions')
@Index('idx_report_definition_owner', ['ownerId'])
@Index('idx_report_definition_scope', ['scope'])
export class ReportDefinition {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'integer' })
  ownerId!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  owner!: User;

  @Column({ type: 'text' })
  config!: string;

  @Column({ type: 'varchar', length: 20, default: 'private' })
  scope!: ReportDefinitionScope;

  @Column({ type: 'integer', nullable: true })
  scopeGroupId!: number | null;

  @Column({ type: 'integer', nullable: true })
  scopeDepartmentId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
