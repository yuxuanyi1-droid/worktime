import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from './User';
import { Permission } from './Permission';

export type PermissionScopeType = 'self' | 'group' | 'department' | 'project' | 'global';
export type UserPermissionGrantStatus = 'active' | 'revoked' | 'expired';
export type UserPermissionGrantSource = 'request' | 'manual' | 'system';

@Entity('user_permission_grants')
@Index(['userId', 'permissionCode', 'status'])
@Index(['scopeType', 'scopeId'])
export class UserPermissionGrant {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  user!: User;

  @Column({ type: 'integer' })
  userId!: number;

  @ManyToOne(() => Permission, { nullable: true, onDelete: 'SET NULL' })
  permission!: Permission | null;

  @Column({ type: 'integer', nullable: true })
  permissionId!: number | null;

  @Column({ type: 'varchar', length: 100 })
  permissionCode!: string;

  @Column({ type: 'varchar', length: 20, default: 'global' })
  scopeType!: PermissionScopeType;

  @Column({ type: 'integer', nullable: true })
  scopeId!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  scopeName!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'request' })
  source!: UserPermissionGrantSource;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: UserPermissionGrantStatus;

  @Column({ type: 'datetime', nullable: true })
  startsAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'integer', nullable: true })
  approvalInstanceId!: number | null;

  @Column({ type: 'integer', nullable: true })
  requestId!: number | null;

  @Column({ type: 'integer', nullable: true })
  grantedById!: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  grantedByName!: string | null;

  @Column({ type: 'datetime', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'integer', nullable: true })
  revokedById!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  revokeReason!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
