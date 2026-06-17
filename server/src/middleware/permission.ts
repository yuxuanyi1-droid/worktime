import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { AccessPolicyService } from '../services/accessPolicyService';

const accessPolicy = new AccessPolicyService();

/**
 * 获取用户完整权限集合。优先复用 authMiddleware 在请求上挂的缓存，避免重复查库。
 */
async function getUserPermissions(req: AuthRequest): Promise<Set<string>> {
  if (req.userPermissions) return req.userPermissions;
  // 兜底：极端情况下（中间件未注入缓存）仍走完整查询
  const perms = await accessPolicy.getPermissionCodes(req.user!.id);
  req.userPermissions = perms;
  return perms;
}

/**
 * 检查是否是管理员
 */
export function isAdmin(req: AuthRequest): boolean {
  return req.user?.roles?.includes('admin') ?? false;
}

/**
 * RBAC 权限校验中间件 - 满足任一权限即可
 */
export const requirePermission = (...requiredPermissions: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
      if (isAdmin(req)) return next();

      const perms = await getUserPermissions(req);
      const hasPermission = requiredPermissions.some(p => perms.has(p));
      if (!hasPermission) {
        return res.status(403).json({ code: 403, message: '无此操作权限' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ code: 500, message: '权限校验失败' });
    }
  };
};

/**
 * RBAC 权限校验中间件 - 必须拥有全部权限
 */
export const requireAllPermissions = (...requiredPermissions: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
      if (isAdmin(req)) return next();

      const perms = await getUserPermissions(req);
      const hasAll = requiredPermissions.every(p => perms.has(p));
      if (!hasAll) {
        return res.status(403).json({ code: 403, message: '无此操作权限' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ code: 500, message: '权限校验失败' });
    }
  };
};

/**
 * 角色校验中间件 - 必须拥有指定角色
 */
export const requireRole = (...roles: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
      if (isAdmin(req)) return next();

      const hasRole = req.user.roles?.some(r => roles.includes(r));
      if (!hasRole) {
        return res.status(403).json({ code: 403, message: '无此角色权限' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ code: 500, message: '权限校验失败' });
    }
  };
};

/**
 * 获取用户所属的部门ID和分组ID（用于审批范围限制）
 */
export async function getUserOrgInfo(userId: number): Promise<{
  departmentId: number | null;
  groupId: number | null;
  roleNames: string[];
}> {
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({
    where: { id: userId },
    relations: ['roles', 'department', 'group'],
  });
  return {
    departmentId: user?.department?.id ?? null,
    groupId: user?.group?.id ?? null,
    roleNames: user?.roles.map(r => r.name) ?? [],
  };
}
