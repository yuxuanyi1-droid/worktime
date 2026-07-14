import crypto from 'crypto';
import { AppDataSource } from '../config/database';
import { PersonalAccessToken } from '../entities/PersonalAccessToken';
import { BusinessError } from '../utils/errors';
import { PAT_PREFIX, hashPat } from '../middleware/auth';

/** PAT 明文随机部分的长度（hex 字符数），与 prefix 展示长度无关 */
const PAT_RANDOM_LEN = 32;
/** 列表展示用的明文前缀字符数（含 wpat_ 前缀） */
const PREFIX_DISPLAY_LEN = 12;
/** 默认令牌名 */
export const DEFAULT_PAT_NAME = '默认令牌';

/**
 * 个人访问令牌服务。
 *
 * 每个用户可拥有多个 PAT，明文 `wpat_<32hex>` 库里完整存储以便用户随时复制（产品需求）。
 * 同时存 sha256（tokenHash）便于 auth 中间件按令牌查表。
 *
 * PAT 权限默认继承用户全部权限（scope 字段预留收窄），鉴权复用 authMiddleware + 现有权限链路。
 */
export class PatService {
  private patRepo = AppDataSource.getRepository(PersonalAccessToken);

  /** 生成明文令牌：wpat_ + 32 位 hex */
  private generatePlainToken(): string {
    return PAT_PREFIX + crypto.randomBytes(PAT_RANDOM_LEN / 2).toString('hex');
  }

  /** 列出当前用户所有 PAT（按创建时间倒序） */
  async listMine(userId: number): Promise<PersonalAccessToken[]> {
    return this.patRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 创建 PAT。
   * @param userId 所属用户
   * @param name 令牌名
   * @param expiresAt 可选过期时间，空=永不过期
   */
  async createMine(userId: number, name: string, expiresAt?: Date): Promise<PersonalAccessToken> {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      throw new BusinessError('令牌名称不能为空');
    }
    if (trimmed.length > 100) {
      throw new BusinessError('令牌名称过长（最多 100 字符）');
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BusinessError('过期时间必须晚于当前时间');
    }

    const plain = this.generatePlainToken();
    const pat = this.patRepo.create({
      userId,
      name: trimmed,
      tokenPlain: plain,
      tokenHash: hashPat(plain),
      prefix: plain.slice(0, PREFIX_DISPLAY_LEN),
      scopes: null,
      lastUsedAt: null,
      expiresAt: expiresAt ?? null,
    });
    return this.patRepo.save(pat);
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

  /**
   * 确保用户至少拥有一个 PAT；若无则创建名为「默认令牌」的永久 PAT。
   * 用于 seed 与首次登录，保证每个用户「默认自带一个 PAT」。
   *
   * 返回保证非空：用户现有的某个 PAT，或新建的默认 PAT。
   */
  async ensureDefaultPat(userId: number): Promise<PersonalAccessToken> {
    const existing = await this.patRepo.findOne({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    if (existing) return existing;
    return this.createMine(userId, DEFAULT_PAT_NAME);
  }

  /**
   * 取用户某个 PAT 明文（优先默认令牌），供 pi agent 会话注入 WORKTIME_PAT。
   * 没有任何 PAT 时自动创建一个默认令牌。
   */
  async getPlainForAgent(userId: number): Promise<string> {
    const pat = await this.ensureDefaultPat(userId);
    return pat.tokenPlain;
  }
}
