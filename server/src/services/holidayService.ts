import { EntityManager } from 'typeorm';
import dayjs from 'dayjs';
import { AppDataSource } from '../config/database';
import { Holiday } from '../entities/Holiday';
import { OvertimeType } from '../entities/OvertimeApplication';
import { BusinessError } from '../utils/errors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 进程内缓存：节假日年度变更少，list/infer 命中缓存避免重复查库。
 * upsert/remove 时整体失效（节假日由管理员低频维护，简单清空比按年失效更安全）。
 *
 * listByYear：key 为年份字符串或 'all'（无 year 过滤）。
 * mapByYear：key 为年份字符串，value 为 Map<dateString, isWorkday>，供 inferOvertimeType 做 O(1) 查找。
 */
interface HolidayCache {
  listByYear: Map<string, Holiday[]>;
  mapByYear: Map<string, Map<string, boolean>>;
}

const cache: HolidayCache = {
  listByYear: new Map(),
  mapByYear: new Map(),
};

/** 清空全部节假日缓存（upsert/remove 后调用）。 */
function invalidateHolidayCache(): void {
  cache.listByYear.clear();
  cache.mapByYear.clear();
}

export class HolidayService {
  constructor(private manager?: EntityManager) {}

  private get repo() { return (this.manager ?? AppDataSource).getRepository(Holiday); }

  /**
   * 列出节假日。
   * @param year 指定年份时按 date LIKE 'year-%' 前缀过滤；省略时返回全部。
   */
  async list(year?: number): Promise<Holiday[]> {
    const key = year ? String(year) : 'all';
    const cached = cache.listByYear.get(key);
    if (cached) return cached;
    const qb = this.repo.createQueryBuilder('h');
    if (year) {
      qb.where('h.date LIKE :prefix', { prefix: `${year}-%` });
    }
    qb.orderBy('h.date', 'ASC');
    const result = await qb.getMany();
    cache.listByYear.set(key, result);
    return result;
  }

  /** 取得某年份 date→isWorkday 的查找表（带缓存）。 */
  private async getMapForYear(year: number): Promise<Map<string, boolean>> {
    const key = String(year);
    const cached = cache.mapByYear.get(key);
    if (cached) return cached;
    const list = await this.list(year);
    const map = new Map<string, boolean>();
    for (const h of list) {
      map.set(h.date, !!h.isWorkday);
    }
    cache.mapByYear.set(key, map);
    return map;
  }

  /**
   * 按年覆盖写入节假日（事务内先删该年再批量插入）。
   * @param year 目标年份
   * @param items 该年份的节假日列表；date 必须属于 year，name 非空
   */
  async upsertYear(year: number, items: { date: string; name: string; isWorkday: boolean }[]): Promise<void> {
    for (const item of items) {
      if (!DATE_RE.test(item.date)) {
        throw new BusinessError(`日期格式无效：${item.date}`);
      }
      if (!item.date.startsWith(`${year}-`)) {
        throw new BusinessError(`日期 ${item.date} 不属于 ${year} 年`);
      }
    }
    const work = async (manager: EntityManager) => {
      const repo = manager.getRepository(Holiday);
      await repo.createQueryBuilder('h')
        .delete()
        .where('h.date LIKE :prefix', { prefix: `${year}-%` })
        .execute();
      if (items.length) {
        await repo.save(items.map(i => repo.create({
          date: i.date,
          name: i.name,
          isWorkday: !!i.isWorkday,
        })));
      }
    };
    if (this.manager) {
      await work(this.manager);
    } else {
      await AppDataSource.transaction(work);
    }
    invalidateHolidayCache();
  }

  /** 删除单个节假日。 */
  async remove(date: string): Promise<void> {
    await this.repo.delete(date);
    invalidateHolidayCache();
  }

  /** 该日期是否为法定休息日/节假日（存在且 isWorkday=false）。 */
  async isHoliday(date: string): Promise<boolean> {
    const year = parseYear(date);
    if (year === null) return false;
    const map = await this.getMapForYear(year);
    return map.get(date) === false;
  }

  /** 该日期是否为调休补班日（存在且 isWorkday=true）。 */
  async isMakeupWorkday(date: string): Promise<boolean> {
    const year = parseYear(date);
    if (year === null) return false;
    const map = await this.getMapForYear(year);
    return map.get(date) === true;
  }

  /**
   * 按节假日日历+周末推断加班类型（服务端权威，覆盖客户端传入值）。
   * - isHoliday → 'holiday'
   * - isMakeupWorkday → 'weekday'（调休补班日按工作日计）
   * - 否则按日期星期：周六/日 → 'weekend'，否则 'weekday'
   */
  async inferOvertimeType(date: string): Promise<OvertimeType> {
    if (await this.isHoliday(date)) return 'holiday';
    if (await this.isMakeupWorkday(date)) return 'weekday';
    const dow = dayjs(date).day(); // 0=周日, 6=周六
    return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
  }
}

function parseYear(date: string): number | null {
  const year = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}
