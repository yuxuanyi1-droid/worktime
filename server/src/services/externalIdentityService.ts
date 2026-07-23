import { AppDataSource } from '../config/database';
import { UserExternalIdentity } from '../entities/UserExternalIdentity';
import { BusinessError } from '../utils/errors';
import { getProviderLabel } from './oidc/registry';
import { normalizeProviderUserInfo, type ProviderUserInfo } from './oidc/provider';
import { EntityManager } from 'typeorm';
import { User } from '../entities/User';
import { assertProviderVisible } from './oidc/registry';
import { oidcConfig } from '../config/auth';

/**
 * 第三方账号绑定服务：负责本地用户与外部身份（Authentik/钉钉等）的绑定关系。
 *
 * 约束：(provider, subject) 全局唯一——一个第三方账号只能绑到一个本地用户，
 * 由实体上的唯一索引保证；业务层在 bind 前显式校验并给出友好错误。
 */
export class ExternalIdentityService {
  constructor(private manager?: EntityManager) {}

  private get source() { return this.manager ?? AppDataSource; }
  private get repo() { return this.source.getRepository(UserExternalIdentity); }
  private get userRepo() { return this.source.getRepository(User); }

  /** 列出指定用户的全部绑定（label 从 registry 取，附带 provider 展示名） */
  async listBindings(userId: number) {
    const list = await this.repo.find({ where: { user: { id: userId } } });
    return list.map((b) => ({
      id: b.id,
      provider: b.provider,
      providerLabel: getProviderLabel(b.provider),
      externalUsername: b.externalUsername,
      employeeId: b.employeeId,
      jit: !!oidcConfig.providers[b.provider]?.jit,
      boundAt: b.boundAt,
    }));
  }

  /**
   * 绑定第三方账号到本地用户。
   * 若该 (provider, subject) 已被任何用户绑定，抛错（防止一个第三方账号绑多个本地用户）。
   */
  async bind(userId: number, provider: string, info: ProviderUserInfo): Promise<UserExternalIdentity> {
    assertProviderVisible(provider);
    const normalizedInfo = normalizeProviderUserInfo(info);
    const user = await this.userRepo.findOneBy({ id: userId, status: 1 });
    if (!user) throw new BusinessError('用户不存在或已被禁用', 401);

    // 全局唯一性校验
    const existing = await this.repo.findOne({
      where: { provider, subject: normalizedInfo.subject },
      relations: ['user'],
    });
    if (existing) {
      if (existing.user?.id === userId) {
        // 已绑定到当前用户：同步展示昵称和 IdP 工号后返回（幂等）
        let changed = false;
        if (normalizedInfo.username && existing.externalUsername !== normalizedInfo.username) {
          existing.externalUsername = normalizedInfo.username;
          changed = true;
        }
        if (normalizedInfo.employeeId && existing.employeeId !== normalizedInfo.employeeId) {
          existing.employeeId = normalizedInfo.employeeId;
          changed = true;
        }
        if (changed) {
          await this.repo.save(existing);
        }
        return existing;
      }
      throw new BusinessError('该第三方账号已绑定到其他用户', 409);
    }

    // 同一用户对同一 provider 通常只允许一个绑定（避免一个本地账号挂多个钉钉号）
    const selfSameProvider = await this.repo.findOne({
      where: { provider, userId },
    });
    if (selfSameProvider) {
      throw new BusinessError(`您已绑定过一个${getProviderLabel(provider)}账号，请先解绑再重新绑定`, 409);
    }

    const identity = this.repo.create({
      provider,
      subject: normalizedInfo.subject,
      externalUsername: normalizedInfo.username ?? null,
      employeeId: normalizedInfo.employeeId ?? null,
      userId,
    });
    try {
      return await this.repo.save(identity);
    } catch (error) {
      const candidate = error as { driverError?: { code?: string }; code?: string };
      if ((candidate.driverError?.code ?? candidate.code) === '23505') {
        throw new BusinessError('该第三方账号或该登录方式已被绑定，请刷新后重试', 409);
      }
      throw error;
    }
  }

  /** 解绑当前用户的指定 provider 绑定 */
  async unbind(userId: number, provider: string): Promise<void> {
    if (oidcConfig.providers[provider]?.jit) {
      throw new BusinessError('主身份源账号由系统自动维护，不能自助解绑', 403);
    }
    const existing = await this.repo.findOne({
      where: { provider, userId },
    });
    if (!existing) {
      throw new BusinessError('未绑定该第三方账号', 404);
    }
    await this.repo.remove(existing);
  }
}
