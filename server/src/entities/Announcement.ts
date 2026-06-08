import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { User } from './User';

export type AnnouncementType = 'info' | 'important' | 'urgent';
export type TargetScope = 'all' | 'department' | 'user';

@Entity('announcements')
export class Announcement {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  content!: string;

  @Column({ type: 'varchar', length: 20, default: 'info' })
  type!: AnnouncementType; // info | important | urgent

  @Column({ type: 'varchar', length: 20, default: 'all' })
  targetScope!: TargetScope; // all | department | user

  @Column({ type: 'integer', nullable: true })
  targetDeptId!: number;

  @Column({ type: 'simple-json', nullable: true })
  targetUserIds!: number[]; // 仅 targetScope='user' 时使用

  @Column({ type: 'integer' })
  createdById!: number;

  @ManyToOne(() => User)
  createdBy!: User;

  @CreateDateColumn()
  createdAt!: Date;
}
