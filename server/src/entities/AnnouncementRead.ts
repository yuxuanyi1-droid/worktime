import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, Unique } from 'typeorm';
import { Announcement } from './Announcement';
import { User } from './User';

@Entity('announcement_reads')
@Unique(['announcementId', 'userId'])
export class AnnouncementRead {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer' })
  announcementId!: number;

  @ManyToOne(() => Announcement)
  announcement!: Announcement;

  @Column({ type: 'integer' })
  userId!: number;

  @ManyToOne(() => User)
  user!: User;

  @CreateDateColumn()
  readAt!: Date;
}
