import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AppDataSource } from '../config/database';
import { authConfig } from '../config/auth';
import { User } from '../entities/User';
import { AccessPolicyService } from './accessPolicyService';
import { BusinessError } from '../utils/errors';
import { validatePassword } from '../utils/validation';

export class AuthService {
  private userRepo = AppDataSource.getRepository(User);
  private accessPolicy = new AccessPolicyService();

  async login(username: string, password: string) {
    const user = await this.userRepo.findOne({
      where: { username, status: 1 },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });

    if (!user) {
      throw new BusinessError('用户名或密码错误');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new BusinessError('用户名或密码错误');
    }

    // 签发 token 时带上 tokenVersion，改密码/登出后 version+1 使旧 token 失效
    const token = jwt.sign(
      { id: user.id, username: user.username, realName: user.realName, v: user.tokenVersion },
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
        mustChangePassword: user.mustChangePassword === true,
      },
    };
  }

  async getProfile(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['roles', 'roles.permissions', 'department', 'group'],
    });

    if (!user) {
      throw new BusinessError('用户不存在');
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
      mustChangePassword: user.mustChangePassword === true,
    };
  }

  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BusinessError('用户不存在');

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) throw new BusinessError('原密码错误');

    // 校验新密码是否符合策略
    const policyError = validatePassword(newPassword);
    if (policyError) throw new BusinessError(policyError);
    // 新密码不能与旧密码相同
    if (oldPassword === newPassword) {
      throw new BusinessError('新密码不能与原密码相同');
    }

    user.password = await bcrypt.hash(newPassword, 12);
    user.tokenVersion += 1;
    user.mustChangePassword = false; // 改密成功后清除强制改密标志
    await this.userRepo.save(user);
    return true;
  }

  /** 登出：使当前 token 失效（tokenVersion+1） */
  async logout(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BusinessError('用户不存在');
    user.tokenVersion += 1;
    await this.userRepo.save(user);
  }

  async updateProfile(userId: number, data: { realName?: string; email?: string; phone?: string }) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BusinessError('用户不存在');

    if (data.realName) user.realName = data.realName;
    if (data.email !== undefined) user.email = data.email;
    if (data.phone !== undefined) user.phone = data.phone;

    await this.userRepo.save(user);
    return this.getProfile(userId);
  }
}
