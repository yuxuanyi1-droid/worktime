import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from './User';

@Entity('notifications')
@Index('idx_notification_user_created', ['userId', 'createdAt'])
@Index('idx_notification_user_read', ['userId', 'isRead'])
export class Notification {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  userId!: number;

  @ManyToOne(() => User)
  user!: User;

  @Column({ type: 'varchar', length: 50 })
  type!: string; // 'approval_pending' | 'approval_approved' | 'approval_rejected' | 'system'

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  content!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  targetType!: string; // 'timesheet' | 'overtime' | 'weekly_report'

  @Column({ type: 'integer', nullable: true })
  targetId!: number;

  @Column({ type: 'boolean', default: false })
  isRead!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
