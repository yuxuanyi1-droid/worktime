import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToMany, JoinTable } from 'typeorm';
import { User } from './User';
import { Permission } from './Permission';

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  name!: string;

  @Column({ type: 'varchar', length: 50 })
  label!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string;

  @ManyToMany(() => User, user => user.roles)
  users!: User[];

  @ManyToMany(() => Permission, permission => permission.roles)
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'roleId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permissionId', referencedColumnName: 'id' },
  })
  permissions!: Permission[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
