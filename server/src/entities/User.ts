import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToMany, ManyToOne, OneToMany, JoinTable } from 'typeorm';
import { Department } from './Department';
import { Group } from './Group';
import { Role } from './Role';
import { Timesheet } from './Timesheet';
import { OvertimeApplication } from './OvertimeApplication';
import { WeeklyReport } from './WeeklyReport';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  username!: string;

  @Column({ type: 'varchar', length: 255 })
  password!: string;

  @Column({ type: 'varchar', length: 50 })
  realName!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  email!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string;

  @Column({ type: 'integer', default: 1 })
  status!: number; // 1: 启用, 0: 禁用

  @ManyToOne(() => Department, department => department.users, { nullable: true })
  department!: Department;

  @ManyToOne(() => Group, group => group.users, { nullable: true })
  group!: Group;

  @ManyToMany(() => Role, role => role.users)
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'userId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'roleId', referencedColumnName: 'id' },
  })
  roles!: Role[];

  @OneToMany(() => Timesheet, timesheet => timesheet.user)
  timesheets!: Timesheet[];

  @OneToMany(() => OvertimeApplication, overtime => overtime.user)
  overtimeApplications!: OvertimeApplication[];

  @OneToMany(() => WeeklyReport, report => report.user)
  weeklyReports!: WeeklyReport[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
