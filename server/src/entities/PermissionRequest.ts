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

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  applicant!: User;

  @Column({ type: 'integer' })
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

  @Column({ type: 'timestamp', nullable: true })
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
