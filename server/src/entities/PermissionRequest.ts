import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from './User';
import { Permission } from './Permission';
import { PermissionScopeType } from './UserPermissionGrant';

export type PermissionRequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';

@Entity('permission_requests')
@Index(['applicantId', 'status'])
@Index(['permissionCode', 'status'])
export class PermissionRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  // SET NULL 保留权限申请历史（审计轨迹）；用户禁用走软删除，正常流程不会触发，applicantId 运行时总有值。
  // 实体列 nullable:true 是为了让 SET NULL 在 DB 层语义正确（直接 DB 删用户时不报 FK 错），TS 类型保持非空。
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  applicant!: User | null;

  @Column({ type: 'integer', nullable: true })
  applicantId!: number;

  @ManyToOne(() => Permission, { nullable: true, onDelete: 'SET NULL' })
  permission!: Permission | null;

  @Column({ type: 'integer', nullable: true })
  permissionId!: number | null;

  @Column({ type: 'varchar', length: 100 })
  permissionCode!: string;

  @Column({ type: 'varchar', length: 100 })
  permissionName!: string;

  @Column({ type: 'varchar', length: 20, default: 'global' })
  scopeType!: PermissionScopeType;

  @Column({ type: 'integer', nullable: true })
  scopeId!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  scopeName!: string | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'datetime', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: PermissionRequestStatus;

  @Column({ type: 'integer', default: 0 })
  currentStep!: number;

  @Column({ type: 'integer', nullable: true })
  approvalFlowId!: number | null;

  @Column({ type: 'integer', nullable: true })
  approvalInstanceId!: number | null;

  @Column({ type: 'integer', default: 0 })
  totalSteps!: number;

  @Column({ type: 'integer', nullable: true })
  grantId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
