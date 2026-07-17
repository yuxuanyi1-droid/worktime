import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from './User';

/**
 * 个人访问令牌（Personal Access Token）。
 *
 * 用于：
 * - pi agent skill 在后端进程内通过 curl 调本系统 HTTP API（把令牌注入会话环境变量 WORKTIME_PAT）
 * - 外部工具（Cursor / ZCode 里跑 pi）直接用同一套 SKILL.md 调本系统 HTTP API
 *
 * 与 JWT 的区别：
 * - JWT 走 tokenVersion 校验，改密/登出即失效；PAT 独立持久，不走 tokenVersion
 * - 明文以 `wpat_<32位hex>` 形式返回给用户；库里同时存明文（tokenPlain，方便用户回来复制）与 sha256（tokenHash，查表用）
 *
 * 注意：明文存储是产品需求（用户希望忘记后可回页复制），DB 泄露即令牌泄露，需注意 DB 访问控制。
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

  /** 明文令牌，完整存储以便用户随时复制（产品需求）。格式 `wpat_<32位hex>` */
  @Column({ type: 'text' })
  tokenPlain!: string;

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
