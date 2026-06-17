import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authConfig } from '../config/auth';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { AccessPolicyService } from '../services/accessPolicyService';

const accessPolicy = new AccessPolicyService();

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    realName: string;
    roles: string[];
  };
  /** 当前请求用户完整权限集合（含角色权限 + 生效中的授权 + 别名/蕴含展开）。请求级缓存。 */
  userPermissions?: Set<string>;
}

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
    };
    // 一次性算出权限集合挂到请求对象，permissionMiddleware 直接复用，避免每个权限校验重复查库
    req.userPermissions = await accessPolicy.getPermissionCodesForLoadedUser(user);

    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Token无效或已过期' });
  }
};
