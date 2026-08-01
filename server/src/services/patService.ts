import crypto from 'crypto';
import { AppDataSource } from '../config/database';
import { PersonalAccessToken } from '../entities/PersonalAccessToken';
import { BusinessError } from '../utils/errors';
import { PAT_PREFIX, hashPat } from '../middleware/auth';
import { EntityManager } from 'typeorm';
import { User } from '../entities/User';

/** PAT 明文随机部分的长度（hex 字符数），与 prefix 展示长度无关 */
const PAT_RANDOM_LEN = 32;
/** 列表展示用的明文前缀字符数（含 wpat_ 前缀） */
const PREFIX_DISPLAY_LEN = 12;
/** 未显式指定过期时间时 PAT 的默认有效期（天）：避免「永不过期」的全权限长期凭证 */
export const PAT_DEFAULT_TTL_DAYS = 90;
/**
 * 个人访问令牌服务。
 *
 * 每个用户可拥有多个 PAT。明文 `wpat_<32hex>` 只在创建时返回一次，
 * 数据库只保存 sha256（tokenHash）和脱敏前缀。
 *
 * PAT 权限默认继承用户全部权限；可传 scopes（权限码数组）收窄：
 * 鉴权时取「用户全量权限 ∩ scopes」作为令牌实际权限（见 middleware/auth.ts）。
 */
export class PatService {
  constructor(private manager?: EntityManager) {}

  private get source() { return this.manager ?? AppDataSource; }
  private get patRepo() { return this.source.getRepository(PersonalAccessToken); }
  private get userRepo() { return this.source.getRepository(User); }

  /** 生成明文令牌：wpat_ + 32 位 hex */
  private generatePlainToken(): string {
    return PAT_PREFIX + crypto.randomBytes(PAT_RANDOM_LEN / 2).toString('hex');
  }

  /** 列出当前用户所有 PAT（按创建时间倒序） */
  async listMine(userId: number): Promise<PersonalAccessToken[]> {
    return this.patRepo.find({
      select: {
        id: true,
        userId: true,
        name: true,
        prefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 创建 PAT。
   * @param userId 所属用户
   * @param name 令牌名
   * @param expiresAt 可选过期时间；未传时默认 90 天（不提供「永不过期」选项）
   * @param scopes 可选权限码收窄（null = 继承用户全部权限）
   */
  async createMine(
    userId: number,
    name: string,
    expiresAt?: Date,
    scopes?: string[],
  ): Promise<PersonalAccessToken & { tokenPlain: string }> {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      throw new BusinessError('令牌名称不能为空');
    }
    if (trimmed.length > 100) {
      throw new BusinessError('令牌名称过长（最多 100 字符）');
    }
    const effectiveExpiresAt = expiresAt ?? new Date(Date.now() + PAT_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
    if (effectiveExpiresAt.getTime() <= Date.now()) {
      throw new BusinessError('过期时间必须晚于当前时间');
    }

    // 每用户令牌上限需要“计数+写入”原子化；通过用户行锁串行化同一用户的并发创建。
    if (!this.manager?.queryRunner?.isTransactionActive) {
      return (this.manager?.connection ?? AppDataSource).transaction((manager) => (
        new PatService(manager).createMine(userId, trimmed, effectiveExpiresAt, scopes)
      ));
    }

    const user = await this.userRepo.createQueryBuilder('user')
      .setLock('pessimistic_write')
      .where('user.id = :userId', { userId })
      .andWhere('user.status = :status', { status: 1 })
      .getOne();
    if (!user) throw new BusinessError('用户不存在或已禁用', 401);
    const activeCount = await this.patRepo.createQueryBuilder('pat')
      .where('pat.userId = :userId', { userId })
      .andWhere('(pat.expiresAt IS NULL OR pat.expiresAt > :now)', { now: new Date() })
      .getCount();
    if (activeCount >= 20) throw new BusinessError('个人访问令牌最多保留 20 个，请先删除不再使用的令牌');

    const plain = this.generatePlainToken();
    const pat = this.patRepo.create({
      userId,
      name: trimmed,
      tokenPlain: null,
      tokenHash: hashPat(plain),
      prefix: plain.slice(0, PREFIX_DISPLAY_LEN),
      // 逗号分隔存储；null = 继承全部权限
      scopes: scopes && scopes.length ? [...new Set(scopes)].join(',') : null,
      lastUsedAt: null,
      expiresAt: effectiveExpiresAt,
    });
    const saved = await this.patRepo.save(pat);
    return Object.assign(saved, { tokenPlain: plain });
  }

  /** 删除指定 PAT（仅限本人） */
  async deleteMine(userId: number, patId: number): Promise<void> {
    const pat = await this.patRepo.findOne({ where: { id: patId } });
    if (!pat) {
      throw new BusinessError('令牌不存在', 404);
    }
    if (pat.userId !== userId) {
      // 不暴露他人令牌是否存在，统一报「不存在」
      throw new BusinessError('令牌不存在', 404);
    }
    await this.patRepo.remove(pat);
  }
}
