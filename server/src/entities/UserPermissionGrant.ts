import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from './User';
import { Permission } from './Permission';

export type PermissionScopeType = 'self' | 'group' | 'department' | 'project' | 'global';
export type UserPermissionGrantStatus = 'active' | 'revoked' | 'expired';
export type UserPermissionGrantSource = 'request' | 'manual' | 'system';

@Entity('user_permission_grants')
@Index(['userId', 'permissionCode', 'status'])
@Index(['scopeType', 'scopeId'])
// 防重复 active 授权：同一用户、权限码、作用域、作用域ID 下只允许一条 active 记录。
// partial unique index（仅对 status='active' 生效），revoked/expired 不受约束，保留历史。
// 注意：SQLite synchronize 不会自动创建这个 partial index，需配套 migration。
@Index('idx_grant_unique_active', ['userId', 'permissionCode', 'scopeType', 'scopeId'], { unique: true, where: 'status = \'active\'' })
export class UserPermissionGrant {
  @PrimaryGeneratedColumn()
  id!: number;

  // SET NULL 保留授权历史；用户禁用走软删除，正常流程不会触发，userId 运行时总有值。
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  user!: User | null;

  @Column({ type: 'integer', nullable: true })
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
