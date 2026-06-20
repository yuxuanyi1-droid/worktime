import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany } from 'typeorm';
import { Department } from './Department';
import { User } from './User';

@Entity('groups')
export class Group {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string;

  /** 所属部门（顶级组必须指定） */
  @ManyToOne(() => Department, department => department.groups, { nullable: true })
  department!: Department | null;

  @Column({ type: 'integer', nullable: true })
  departmentId!: number | null;

  /** 父级分组（null 表示顶级组） */
  @ManyToOne(() => Group, group => group.children, { nullable: true })
  parent!: Group | null;

  @Column({ type: 'integer', nullable: true })
  parentId!: number | null;

  /** 子分组 */
  @OneToMany(() => Group, group => group.parent)
  children!: Group[];

  /** 组负责人（默认审批人） */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  leader!: User | null;

  @Column({ type: 'integer', nullable: true })
  leaderId!: number | null;

  @OneToMany(() => User, user => user.group)
  users!: User[];

  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  /** 层级深度（0=顶级组, 1=二级组, ...） */
  @Column({ type: 'integer', default: 0 })
  level!: number;

  /** 层级路径，如 "1/3/7"，根到自身的 ID 路径 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  path!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
