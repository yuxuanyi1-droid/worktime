import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authConfig } from '../config/auth';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { AccessPolicyService } from '../services/accessPolicyService';
import { logger } from '../utils/logger';

const accessPolicy = new AccessPolicyService();

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    realName: string;
    roles: string[];
    mustChangePassword: boolean;
  };
  /** 当前请求用户完整权限集合（含角色权限 + 生效中的授权 + 别名/蕴含展开）。请求级缓存。 */
  userPermissions?: Set<string>;
}

/**
 * 强制改密白名单：以下路径允许 mustChangePassword=true 的用户访问。
 * 改密、查看/更新个人信息、登出、获取权限模型 都需要放行，否则用户无法完成改密流程。
 */
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = new Set([
  '/api/v1/auth/change-password',
  '/api/v1/auth/profile',
  '/api/v1/auth/logout',
  '/api/v1/auth/permission-model',
]);

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ code: 401, message: '未提供认证Token' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, authConfig.jwtSecret) as any;

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
      mustChangePassword: user.mustChangePassword === true,
    };

    // 强制改密拦截：管理员重置密码 / seed 默认账号后必须先改密，否则除白名单外的请求一律 423
    if (user.mustChangePassword && !MUST_CHANGE_PASSWORD_ALLOWED_PATHS.has(req.path)) {
      return res.status(423).json({
        code: 423,
        message: '需要先修改初始密码才能继续操作',
        mustChangePassword: true,
      });
    }

    // 一次性算出权限集合挂到请求对象，permissionMiddleware 直接复用，避免每个权限校验重复查库
    req.userPermissions = await accessPolicy.getPermissionCodesForLoadedUser(user);

    next();
  } catch (error) {
    // R7：jwt 过期/格式错误属正常情况（不记日志），其它异常（DB 故障等）需记录便于排查
    const err = error as any;
    const isJwtError = err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError';
    if (!isJwtError) {
      logger.error({ err: error, path: req.path }, '认证中间件异常');
    }
    return res.status(401).json({ code: 401, message: 'Token无效或已过期' });
  }
};
