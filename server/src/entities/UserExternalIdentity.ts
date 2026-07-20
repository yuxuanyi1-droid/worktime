import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from './User';

/**
 * 用户外部身份绑定（第三方登录账号）。
 *
 * 一个本地用户可绑定 N 个外部身份（如同时绑定 Authentik、钉钉），
 * 用于「OIDC 登录」与「个人中心绑定第三方账号」。
 *
 * (provider, subject) 全局唯一：一个第三方账号只能绑定到一个本地用户，
 * 防止同一 IdP 账号被多个本地用户重复绑定。
 */
@Entity('user_external_identities')
@Index('idx_ext_identity_unique', ['provider', 'subject'], { unique: true })
export class UserExternalIdentity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 提供商 id（如 'authentik' | 'dingtalk'，对应 oidcConfig.providers 的 key） */
  @Column({ type: 'varchar', length: 50 })
  provider!: string;

  /** IdP 侧唯一标识（标准 OIDC 的 sub / 钉钉的 unionId） */
  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  /** IdP 侧用户名/昵称（展示用，不参与身份匹配） */
  @Column({ type: 'varchar', length: 255, nullable: true })
  externalUsername!: string | null;

  /** IdP 返回的员工工号；TT 等企业内部通道使用，不能用本地 username 替代。 */
  @Column({ type: 'varchar', length: 100, nullable: true })
  employeeId!: string | null;

  @ManyToOne(() => User, user => user.externalIdentities, { onDelete: 'CASCADE' })
  user!: User;

  @CreateDateColumn()
  boundAt!: Date;
}
