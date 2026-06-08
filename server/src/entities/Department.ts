import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToOne } from 'typeorm';
import { User } from './User';
import { Group } from './Group';

@Entity('departments')
export class Department {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string;

  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  /** 部门负责人（默认审批人） */
  @ManyToOne(() => User, { nullable: true })
  leader!: User | null;

  @Column({ type: 'integer', nullable: true })
  leaderId!: number | null;

  @OneToMany(() => User, user => user.department)
  users!: User[];

  @OneToMany(() => Group, group => group.department)
  groups!: Group[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
