import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from './User';

@Entity('audit_logs')
@Index('idx_audit_user_created', ['userId', 'createdAt'])
@Index('idx_audit_action_target', ['action', 'target'])
@Index('idx_audit_created', ['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer', nullable: true })
  userId!: number | null;

  @ManyToOne(() => User, { nullable: true })
  user!: User;

  @Column({ type: 'varchar', length: 50 })
  action!: string; // 'create' | 'update' | 'delete' | 'submit' | 'approve' | 'reject' | 'login'

  @Column({ type: 'varchar', length: 50 })
  target!: string; // 'timesheet' | 'overtime' | 'weekly_report' | 'user' | 'system'

  @Column({ type: 'integer', nullable: true })
  targetId!: number;

  @Column({ type: 'text', nullable: true })
  detail!: string;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
