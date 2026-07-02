import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * 登录失败计数（持久化）。
 * 替代原先进程内 Map 的实现——多实例部署时各实例共享同一份数据，
 * 避免攻击者轮询不同实例绕过登录锁定。better-sqlite3 同步且快，适合作为轻量计数存储。
 *
 * 主键 loginKey = `${ip}:${username}`，与原内存实现保持一致。
 * lockedUntil 为锁定到期时间戳（ms），为 null 表示未锁定。
 */
@Entity('login_attempts')
@Index('idx_login_attempts_last_failed', ['lastFailedAt'])
export class LoginAttempt {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  loginKey!: string;

  @Column({ type: 'integer', default: 0 })
  failCount!: number;

  /** 锁定到期时间戳（ms），null 表示未锁定 */
  @Column({ type: 'bigint', nullable: true })
  lockedUntil!: number | null;

  @Column({ type: 'bigint' })
  lastFailedAt!: number;
}
