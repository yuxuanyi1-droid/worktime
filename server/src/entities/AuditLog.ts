import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { User } from './User';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  userId!: number;

  @ManyToOne(() => User)
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
