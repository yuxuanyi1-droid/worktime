import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToMany } from 'typeorm';
import { Role } from './Role';

@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 50 })
  module!: string;

  @Column({ type: 'varchar', length: 50 })
  action!: string;

  @Column({ type: 'boolean', default: false })
  grantable!: boolean;

  @Column({ type: 'simple-json', nullable: true })
  scopeTypes!: string[] | null;

  @ManyToMany(() => Role, role => role.permissions)
  roles!: Role[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
