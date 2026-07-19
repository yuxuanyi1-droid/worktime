import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from './User';

/**
 * 个人访问令牌（Personal Access Token）。
 *
 * 用于：
 * - 外部工具（Cursor / ZCode 里跑 pi）直接用同一套 SKILL.md 调本系统 HTTP API
 *
 * 与 JWT 的区别：
 * - JWT 走 tokenVersion 校验，改密/登出即失效；PAT 独立持久，不走 tokenVersion
 * - 明文以 `wpat_<32位hex>` 形式仅在创建响应中返回一次；库里只保留 sha256 和脱敏前缀
 */
@Entity('personal_access_tokens')
@Index(['userId', 'createdAt'])
export class PersonalAccessToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  user!: User;

  @Column({ type: 'integer' })
  userId!: number;

  /** 令牌名称，如「默认令牌」/ 用户自定义 */
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** sha256(明文)，用于按 token 快速查找（auth 中间件用） */
  @Column({ type: 'varchar', length: 255 })
  tokenHash!: string;

  /** 兼容旧 schema 的遗留列；安全迁移后清空，新令牌不再保存明文。 */
  @Column({ type: 'text', nullable: true, select: false })
  tokenPlain!: string | null;

  /** 明文前 12 位，用于列表展示脱敏预览，如 `wpat_abc12...` */
  @Column({ type: 'varchar', length: 20 })
  prefix!: string;

  /** 预留：scope 收窄（逗号分隔权限码），空表示继承用户全部权限 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  scopes!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt!: Date | null;

  /** 过期时间，空=永不过期 */
  @Column({ type: 'timestamp', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
