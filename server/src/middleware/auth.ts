import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authConfig } from '../config/auth';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { PersonalAccessToken } from '../entities/PersonalAccessToken';
import { AccessPolicyService } from '../services/accessPolicyService';
import { CacheKeys, CacheTtl, cacheGet, cacheSet } from '../config/cache';

const accessPolicy = new AccessPolicyService();

type CachedAuthUser = {
  id: number;
  username: string;
  realName: string;
  roles: string[];
  permissions: string[];
  tokenVersion: number;
};

/** PAT 明文前缀，auth 中间件据此区分 JWT 与 PAT */
export const PAT_PREFIX = 'wpat_';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    realName: string;
    roles: string[];
  };
  /** 当前请求用户完整权限集合（含角色权限 + 生效中的授权 + 别名/蕴含展开）。请求级缓存。 */
  userPermissions?: Set<string>;
  /** 当前请求的认证方式：jwt（登录会话）或 pat（个人访问令牌，用于 pi skill / 外部工具） */
  authMethod?: 'jwt' | 'pat';
}

/**
 * 计算 PAT 明文的 sha256（hex），用于按令牌查表。
 * 库里同时存明文（tokenPlain）与 sha256（tokenHash）。
 */
export function hashPat(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

/**
 * 统一鉴权中间件：同时识别 JWT（用户登录会话）和 PAT（个人访问令牌）。
 *
 * 分流依据：Authorization 头的 token 是否以 `wpat_` 开头。
 * - JWT 路径：校验签名 + tokenVersion（改密/登出 +1 即失效）
 * - PAT 路径：按 sha256 查表 + 校验 expiresAt + 关联用户状态；跳过 tokenVersion（PAT 独立持久）
 *
 * 两条路径最终都挂 req.user / req.userPermissions / req.authMethod，下游完全一致。
 */
export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: 401, message: '未提供认证Token' });
    }

    const token = authHeader.split(' ')[1];

    // PAT 分支：token 以 wpat_ 开头
    if (token.startsWith(PAT_PREFIX)) {
      return await authenticatePat(token, req, res, next);
    }

    // JWT 分支：原有逻辑
    const decoded = jwt.verify(token, authConfig.jwtSecret) as any;

    const cacheKey = CacheKeys.authUser(decoded.id);
    const cached = await cacheGet<CachedAuthUser>(cacheKey);
    if (cached) {
      if (decoded.v !== cached.tokenVersion) {
        return res.status(401).json({ code: 401, message: '登录已失效，请重新登录' });
      }
      req.user = {
        id: cached.id,
        username: cached.username,
        realName: cached.realName,
        roles: cached.roles,
      };
      req.userPermissions = new Set(cached.permissions);
      req.authMethod = 'jwt';
      return next();
    }

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: decoded.id, status: 1 },
      relations: ['roles', 'roles.permissions'],
    });

    if (!user) {
      return res.status(401).json({ code: 401, message: '用户不存在或已禁用' });
    }

    // 校验 token 版本：改密/登出后 version+1，旧 token 即失效
    if (decoded.v !== user.tokenVersion) {
      return res.status(401).json({ code: 401, message: '登录已失效，请重新登录' });
    }

    req.user = {
      id: user.id,
      username: user.username,
      realName: user.realName,
      roles: user.roles.map(r => r.name),
    };
    // 一次性算出权限集合挂到请求对象，permissionMiddleware 直接复用，避免每个权限校验重复查库
    req.userPermissions = await accessPolicy.getPermissionCodesForLoadedUser(user);
    req.authMethod = 'jwt';

    await cacheSet(cacheKey, {
      ...req.user,
      permissions: Array.from(req.userPermissions),
      tokenVersion: user.tokenVersion,
    } satisfies CachedAuthUser, CacheTtl.auth);

    return next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Token无效或已过期' });
  }
};

/**
 * PAT 鉴权：按 sha256 查 PAT 表 → 校验过期 → 加载用户 → 挂 req.user。
 * PAT 不走 tokenVersion，与 JWT 生命周期解耦（改密不会自动吊销 PAT）。
 */
async function authenticatePat(token: string, req: AuthRequest, res: Response, next: NextFunction) {
  const patRepo = AppDataSource.getRepository(PersonalAccessToken);
  const userRepo = AppDataSource.getRepository(User);

  const pat = await patRepo.findOne({
    where: { tokenHash: hashPat(token) },
    relations: ['user'],
  });

  if (!pat) {
    return res.status(401).json({ code: 401, message: '访问令牌无效' });
  }

  // 过期校验
  if (pat.expiresAt && pat.expiresAt.getTime() < Date.now()) {
    return res.status(401).json({ code: 401, message: '访问令牌已过期' });
  }

  const user = pat.user;
  if (!user || user.status !== 1) {
    return res.status(401).json({ code: 401, message: '令牌所属用户不存在或已禁用' });
  }

  // 加载角色关系用于权限计算
  const fullUser = await userRepo.findOne({
    where: { id: user.id },
    relations: ['roles', 'roles.permissions'],
  });
  if (!fullUser) {
    return res.status(401).json({ code: 401, message: '用户不存在或已禁用' });
  }

  // 异步更新 lastUsedAt（不阻塞请求，失败也忽略）
  pat.lastUsedAt = new Date();
  patRepo.save(pat).catch(() => { /* best-effort，不影响主流程 */ });

  req.user = {
    id: fullUser.id,
    username: fullUser.username,
    realName: fullUser.realName,
    roles: fullUser.roles.map(r => r.name),
  };
  req.userPermissions = await accessPolicy.getPermissionCodesForLoadedUser(fullUser);
  req.authMethod = 'pat';

  return next();
}
