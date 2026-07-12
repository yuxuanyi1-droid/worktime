import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToMany, JoinTable } from 'typeorm';
import { Timesheet } from './Timesheet';
import { User } from './User';
import { ProjectSE } from './ProjectSE';
import { ProjectWorkloadAllocation } from './ProjectWorkloadAllocation';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string;

  // active=进行中, completed=已完成, suspended=已中止, cancelled=已取消
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  /** 项目管理员（可多人） */
  @ManyToMany(() => User)
  @JoinTable({
    name: 'project_managers',
    joinColumn: { name: 'projectId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'userId', referencedColumnName: 'id' },
  })
  managers!: User[];

  @OneToMany(() => Timesheet, timesheet => timesheet.project)
  timesheets!: Timesheet[];

  @OneToMany(() => ProjectSE, projectSE => projectSE.project)
  moduleSEs!: ProjectSE[];

  /** 项目工时配额（按组配置，单位人/天） */
  @OneToMany(() => ProjectWorkloadAllocation, allocation => allocation.project)
  workloadAllocations!: ProjectWorkloadAllocation[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
