import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '../config/database';
import { authConfig } from '../config/auth';
import { User } from '../entities/User';
import { AccessPolicyService } from './accessPolicyService';

export class AuthService {
  private userRepo = AppDataSource.getRepository(User);
  private accessPolicy = new AccessPolicyService();

  async login(username: string, password: string) {
    const user = await this.userRepo.findOne({
      where: { username, status: 1 },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });

    if (!user) {
      throw new Error('用户名或密码错误');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new Error('用户名或密码错误');
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, realName: user.realName },
      authConfig.jwtSecret,
      { expiresIn: authConfig.jwtExpiresIn } as jwt.SignOptions
    );

    const permissions = Array.from(await this.accessPolicy.getPermissionCodes(user.id));

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        realName: user.realName,
        email: user.email,
        phone: user.phone,
        department: user.department ? { id: user.department.id, name: user.department.name } : null,
        group: user.group ? { id: user.group.id, name: user.group.name } : null,
        roles: user.roles.map(r => ({ id: r.id, name: r.name, label: r.label })),
        permissions,
      },
    };
  }

  async getProfile(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });

    if (!user) {
      throw new Error('用户不存在');
    }

    const permissions = Array.from(await this.accessPolicy.getPermissionCodes(user.id));

    return {
      id: user.id,
      username: user.username,
      realName: user.realName,
      email: user.email,
      phone: user.phone,
      department: user.department ? { id: user.department.id, name: user.department.name } : null,
      group: user.group ? { id: user.group.id, name: user.group.name } : null,
      roles: user.roles.map(r => ({ id: r.id, name: r.name, label: r.label })),
      permissions,
    };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('用户不存在');

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) throw new Error('原密码错误');

    user.password = await bcrypt.hash(newPassword, 10);
    await this.userRepo.save(user);
    return true;
  }

  async updateProfile(userId: number, data: { realName?: string; email?: string; phone?: string }) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('用户不存在');

    if (data.realName) user.realName = data.realName;
    if (data.email !== undefined) user.email = data.email;
    if (data.phone !== undefined) user.phone = data.phone;

    await this.userRepo.save(user);
    return this.getProfile(userId);
  }
}
