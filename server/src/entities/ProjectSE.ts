import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { Project } from './Project';
import { User } from './User';
import { Group } from './Group';

/**
 * 项目模块SE（System Engineer）
 * 每个SE绑定一个组，负责该组成员在此项目中的技术审批
 */
@Entity('project_ses')
export class ProjectSE {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Project, project => project.moduleSEs)
  project!: Project;

  @Column({ type: 'integer' })
  projectId!: number;

  /** SE 用户 */
  @ManyToOne(() => User)
  user!: User;

  @Column({ type: 'integer' })
  userId!: number;

  /** SE 负责的组（SE 与组绑定） */
  @ManyToOne(() => Group)
  group!: Group;

  @Column({ type: 'integer' })
  groupId!: number;

  /** SE 名称（冗余，方便展示） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  userName!: string;

  /** 组名称（冗余） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  groupName!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
