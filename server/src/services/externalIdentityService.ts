import { AppDataSource } from '../config/database';
import { UserExternalIdentity } from '../entities/UserExternalIdentity';
import { BusinessError } from '../utils/errors';
import { getProviderLabel } from './oidc/registry';
import type { ProviderUserInfo } from './oidc/provider';

/**
 * 第三方账号绑定服务：负责本地用户与外部身份（Authentik/钉钉等）的绑定关系。
 *
 * 约束：(provider, subject) 全局唯一——一个第三方账号只能绑到一个本地用户，
 * 由实体上的唯一索引保证；业务层在 bind 前显式校验并给出友好错误。
 */
export class ExternalIdentityService {
  private repo = AppDataSource.getRepository(UserExternalIdentity);

  /** 列出指定用户的全部绑定（label 从 registry 取，附带 provider 展示名） */
  async listBindings(userId: number) {
    const list = await this.repo.find({ where: { user: { id: userId } } });
    return list.map((b) => ({
      id: b.id,
      provider: b.provider,
      providerLabel: getProviderLabel(b.provider),
      externalUsername: b.externalUsername,
      boundAt: b.boundAt,
    }));
  }

  /**
   * 绑定第三方账号到本地用户。
   * 若该 (provider, subject) 已被任何用户绑定，抛错（防止一个第三方账号绑多个本地用户）。
   */
  async bind(userId: number, provider: string, info: ProviderUserInfo): Promise<UserExternalIdentity> {
    // 全局唯一性校验
    const existing = await this.repo.findOne({
      where: { provider, subject: info.subject },
      relations: ['user'],
    });
    if (existing) {
      if (existing.user?.id === userId) {
        // 已绑定到当前用户：仅更新展示昵称后返回（幂等）
        if (info.username && existing.externalUsername !== info.username) {
          existing.externalUsername = info.username;
          await this.repo.save(existing);
        }
        return existing;
      }
      throw new BusinessError('该第三方账号已绑定到其他用户', 409);
    }

    // 同一用户对同一 provider 通常只允许一个绑定（避免一个本地账号挂多个钉钉号）
    const selfSameProvider = await this.repo.findOne({
      where: { provider, user: { id: userId } },
    });
    if (selfSameProvider) {
      throw new BusinessError(`您已绑定过一个${getProviderLabel(provider)}账号，请先解绑再重新绑定`, 409);
    }

    const identity = this.repo.create({
      provider,
      subject: info.subject,
      externalUsername: info.username ?? null,
      user: { id: userId } as any,
    });
    return this.repo.save(identity);
  }

  /** 解绑当前用户的指定 provider 绑定 */
  async unbind(userId: number, provider: string): Promise<void> {
    const existing = await this.repo.findOne({
      where: { provider, user: { id: userId } },
    });
    if (!existing) {
      throw new BusinessError('未绑定该第三方账号', 404);
    }
    await this.repo.remove(existing);
  }
}
