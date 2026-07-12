import { AppDataSource } from '../config/database';
import { AuditLog } from '../entities/AuditLog';
import { logger } from '../utils/logger';

export class AuditService {
  private repo = AppDataSource.getRepository(AuditLog);

  async log(data: {
    userId?: number | null;
    action: string;
    target: string;
    targetId?: number;
    detail?: string;
    ip?: string;
  }) {
    try {
      const log = this.repo.create(data);
      await this.repo.save(log);
    } catch (e) {
      // 审计写入失败不影响业务，但需记录到日志便于排查（合规场景下审计丢失是严重问题）
      logger.error({ err: e, auditData: data }, '审计日志写入失败');
    }
  }

  async getLogs(params: {
    userId?: number;
    action?: string;
    target?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    pageSize?: number;
  }) {
    const { userId, action, target, startDate, endDate, page = 1, pageSize = 20 } = params;
    const qb = this.repo.createQueryBuilder('l')
      .leftJoinAndSelect('l.user', 'u');

    if (userId) qb.andWhere('l.userId = :userId', { userId });
    if (action) qb.andWhere('l.action = :action', { action });
    if (target) qb.andWhere('l.target = :target', { target });
    if (startDate && endDate) {
      qb.andWhere('l.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate });
    }

    qb.orderBy('l.createdAt', 'DESC');
    const total = await qb.getCount();
    const list = await qb.skip((page - 1) * pageSize).take(pageSize).getMany();

    return {
      list: list.map((l: any) => ({
        id: l.id,
        userId: l.userId,
        userName: l.user?.realName || '未知',
        action: l.action,
        target: l.target,
        targetId: l.targetId,
        detail: l.detail,
        ip: l.ip,
        createdAt: l.createdAt,
      })),
      total, page, pageSize,
    };
  }
}
