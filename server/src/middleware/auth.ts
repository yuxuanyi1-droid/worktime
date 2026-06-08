import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { authConfig } from '../config/auth';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    realName: string;
    roles: string[];
  };
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

    req.user = {
      id: user.id,
      username: user.username,
      realName: user.realName,
      roles: user.roles.map(r => r.name),
    };

    next();
  } catch (error) {
    return res.status(401).json({ code: 401, message: 'Token无效或已过期' });
  }
};
