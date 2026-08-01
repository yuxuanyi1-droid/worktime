import { EntityManager, SelectQueryBuilder } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Timesheet } from '../entities/Timesheet';
import { OvertimeApplication } from '../entities/OvertimeApplication';
import { AccessPolicyService, AccessViewer } from './accessPolicyService';
import { BusinessError } from '../utils/errors';
import { assertReportRange } from './reportService';
import {
  parseArray,
  parseDateString,
  parseEnum,
  parsePositiveInt,
  round2,
} from '../utils/validation';

// ===================== 配置 schema =====================

export type ReportSource = 'timesheet' | 'overtime';
export type ReportDimension =
  | 'user'
  | 'project'
  | 'date'
  | 'month'
  | 'department'
  | 'group'
  | 'overtimeType';
export type ReportMeasure = 'sumDays' | 'count' | 'distinctUsers';
export type ReportStatus = 'approved' | 'submitted' | 'draft';
export type ReportOvertimeType = 'weekday' | 'weekend' | 'holiday';

export interface ReportQueryFilters {
  departmentIds?: number[];
  groupIds?: number[];
  userIds?: number[];
  projectIds?: number[];
  statuses?: ReportStatus[];
  overtimeTypes?: ReportOvertimeType[];
}

export interface ReportQueryConfig {
  source: ReportSource;
  startDate: string;
  endDate: string;
  rowDimension: ReportDimension;
  colDimension?: ReportDimension | null;
  measures: ReportMeasure[];
  filters?: ReportQueryFilters;
}

export interface ReportCellMeasures {
  sumDays?: number;
  count?: number;
  distinctUsers?: number;
}

export interface ReportDimensionKey {
  key: string;
  label: string;
}

export interface ReportQueryResult {
  rowKeys: ReportDimensionKey[];
  colKeys: ReportDimensionKey[];
  cells: Record<string, Record<string, ReportCellMeasures>>;
  rowTotals: Record<string, ReportCellMeasures>;
  colTotals: Record<string, ReportCellMeasures>;
  grandTotal: ReportCellMeasures;
}

// ===================== 白名单常量 =====================

const ALLOWED_SOURCES: readonly ReportSource[] = ['timesheet', 'overtime'];
const ALLOWED_DIMENSIONS: readonly ReportDimension[] = [
  'user',
  'project',
  'date',
  'month',
  'department',
  'group',
  'overtimeType',
];
const ALLOWED_MEASURES: readonly ReportMeasure[] = ['sumDays', 'count', 'distinctUsers'];
const ALLOWED_STATUSES: readonly ReportStatus[] = ['approved', 'submitted', 'draft'];
const ALLOWED_OVERTIME_TYPES: readonly ReportOvertimeType[] = ['weekday', 'weekend', 'holiday'];

const TOTAL_COL = '__TOTAL__';
const UNKNOWN_USER = '未知人员';
const UNKNOWN_PROJECT = '未分配项目';
const UNKNOWN_DEPARTMENT = '未分配部门';
const UNKNOWN_GROUP = '未分配组别';

// ===================== 配置校验 =====================

function parseIdArray(value: unknown, field: string): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  return parseArray(value, field, (item, index) =>
    parsePositiveInt(item, `${field}[${index}]`),
  );
}

function parseFilters(filters: unknown): ReportQueryFilters {
  if (filters === undefined || filters === null) return { statuses: ['approved'] };
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new BusinessError('filters 必须为对象');
  }
  const f = filters as Record<string, unknown>;
  const result: ReportQueryFilters = {};
  result.departmentIds = parseIdArray(f.departmentIds, 'departmentIds');
  result.groupIds = parseIdArray(f.groupIds, 'groupIds');
  result.userIds = parseIdArray(f.userIds, 'userIds');
  result.projectIds = parseIdArray(f.projectIds, 'projectIds');
  if (f.statuses === undefined || f.statuses === null) {
    result.statuses = ['approved'];
  } else {
    result.statuses = parseArray(f.statuses, 'statuses', (item, index) =>
      parseEnum(item, `statuses[${index}]`, ALLOWED_STATUSES),
    );
    if (!result.statuses.length) throw new BusinessError('statuses 不能为空');
  }
  if (f.overtimeTypes !== undefined && f.overtimeTypes !== null) {
    result.overtimeTypes = parseArray(f.overtimeTypes, 'overtimeTypes', (item, index) =>
      parseEnum(item, `overtimeTypes[${index}]`, ALLOWED_OVERTIME_TYPES),
    );
  }
  return result;
}

/** 校验并规范化引擎输入配置。所有枚举走 parseEnum 白名单，杜绝任意字符串进入 SQL。 */
export function validateReportQueryConfig(config: unknown): ReportQueryConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new BusinessError('config 必须为对象');
  }
  const c = config as Record<string, unknown>;
  const source = parseEnum(c.source, 'source', ALLOWED_SOURCES);
  const startDate = parseDateString(c.startDate, 'startDate');
  const endDate = parseDateString(c.endDate, 'endDate');
  if (startDate > endDate) throw new BusinessError('startDate 不能晚于 endDate');
  assertReportRange(startDate, endDate);
  const rowDimension = parseEnum(c.rowDimension, 'rowDimension', ALLOWED_DIMENSIONS);
  const colDimension =
    c.colDimension === undefined || c.colDimension === null
      ? null
      : parseEnum(c.colDimension, 'colDimension', ALLOWED_DIMENSIONS);
  const measures = parseArray(
    c.measures,
    'measures',
    (item, index) => parseEnum(item, `measures[${index}]`, ALLOWED_MEASURES),
    { min: 1 },
  );
  const filters = parseFilters(c.filters);

  // overtimeType 维度/过滤仅对 overtime 源合法，避免在 timesheet 源上产生无意义分组
  if (
    (rowDimension === 'overtimeType' || colDimension === 'overtimeType') &&
    source !== 'overtime'
  ) {
    throw new BusinessError('overtimeType 维度仅适用于 overtime 数据源');
  }
  if (filters.overtimeTypes?.length && source !== 'overtime') {
    throw new BusinessError('overtimeTypes 过滤仅适用于 overtime 数据源');
  }

  return { source, startDate, endDate, rowDimension, colDimension, measures, filters };
}

// ===================== 维度表达式（白名单映射，严禁拼接用户输入） =====================

type DimensionExpr = { keyExpr: string; labelExpr: string };

/**
 * 将维度枚举映射到硬编码的列表达式。
 *
 * 安全要点：
 *  - 入参 dim 只来自 parseEnum 白名单，不可能是任意字符串；
 *  - 返回的表达式全部是写死的标识符 / SUBSTR / COALESCE，不包含用户输入；
 *  - 因此可安全拼入 SELECT / GROUP BY，不存在注入面。
 */
function dimensionExpr(source: ReportSource, dim: ReportDimension): DimensionExpr {
  const alias = source === 'timesheet' ? 't' : 'o';
  switch (dim) {
    case 'user':
      return {
        keyExpr: `${alias}."userId"`,
        labelExpr: `COALESCE(u."realName", '${UNKNOWN_USER}')`,
      };
    case 'project':
      return {
        keyExpr: `${alias}."projectId"`,
        labelExpr: `COALESCE(p."name", '${UNKNOWN_PROJECT}')`,
      };
    case 'date':
      return { keyExpr: `${alias}."date"`, labelExpr: `${alias}."date"` };
    case 'month':
      // SUBSTR 兼容 PostgreSQL 与 SQLite，不使用 to_char 等 PG 专属语法
      return {
        keyExpr: `SUBSTR(${alias}."date", 1, 7)`,
        labelExpr: `SUBSTR(${alias}."date", 1, 7)`,
      };
    case 'department':
      return {
        keyExpr: `${alias}."departmentSnapshotId"`,
        labelExpr: `COALESCE(${alias}."departmentSnapshotName", '${UNKNOWN_DEPARTMENT}')`,
      };
    case 'group':
      return {
        keyExpr: `${alias}."groupSnapshotId"`,
        labelExpr: `COALESCE(${alias}."groupSnapshotName", '${UNKNOWN_GROUP}')`,
      };
    case 'overtimeType':
      // validateReportQueryConfig 已确保仅 overtime 源到达此处
      return {
        keyExpr: `${alias}."overtimeType"`,
        labelExpr: `${alias}."overtimeType"`,
      };
    default:
      // 兜底：parseEnum 已限制取值，理论上不会到达
      throw new BusinessError('不支持的维度');
  }
}

function measureExpr(source: ReportSource, measure: ReportMeasure): string {
  const alias = source === 'timesheet' ? 't' : 'o';
  switch (measure) {
    case 'sumDays':
      return `SUM(${alias}."days")`;
    case 'count':
      return `COUNT(*)`;
    case 'distinctUsers':
      return `COUNT(DISTINCT ${alias}."userId")`;
    default:
      throw new BusinessError('不支持的量度');
  }
}

// ===================== 可见范围裁剪 =====================

interface ComputedScope {
  /** 经裁剪后实际生效的过滤条件（部门/组/项目为求交后的集合，userIds 为 self 兜底后的集合）。 */
  effective: ReportQueryFilters;
  /** 多个组织轴时是否 OR 合并（无显式过滤时使用可访问集作为范围）。 */
  matchAnyScope: boolean;
  /** 显式请求了越权范围 → 直接返回空结果（防越权）。 */
  denyAll: boolean;
}

function intersectOr(requested: number[] | undefined, accessible: number[]): number[] {
  if (requested && requested.length) {
    return requested.filter((id) => accessible.includes(id));
  }
  return accessible;
}

/**
 * 基于 viewer 的 report:view:* 权限推导可访问数据范围，并把请求的 filters 与可访问集求交。
 *
 * 规则：
 *  1. admin 或 report:view:all（不限范围）→ 不裁剪，原样使用请求 filters。
 *  2. 完全没有 report:view:*（仅有 report:custom:view）→ 只能看本人（userId = viewer.id）。
 *  3. 否则按部门/组/项目可访问集与请求 filters 求交：
 *     - 显式请求了组织过滤 → 用 AND 合并求交结果；任一轴求交为空 → denyAll（防越权）。
 *     - 未请求组织过滤 → 用可访问集作为范围；多轴时 OR（matchAnyScope），全空 → 回退本人。
 *  4. userIds 始终原样生效（由组织轴范围在 SQL 层约束，防止越权查看他人）。
 */
async function computeScope(
  accessPolicy: AccessPolicyService,
  viewer: AccessViewer,
  filters: ReportQueryFilters,
  source: ReportSource,
): Promise<ComputedScope> {
  const emptyResult = (over: Partial<ReportQueryFilters> = {}): ComputedScope => ({
    effective: { ...filters, ...over },
    matchAnyScope: false,
    denyAll: false,
  });

  // 规则 1：不受范围限制
  if (
    accessPolicy.isAdmin(viewer) ||
    (await accessPolicy.hasUnrestrictedPermission(viewer, 'report:view:all'))
  ) {
    return emptyResult();
  }

  // 按 source 隔离权限码：overtime 源要求 report:view:overtime(/all)；
  // timesheet 源用 timesheet 相关 report:view:*，避免仅 timesheet 报表权限的用户在自定义报表里读到加班数据。
  const isOvertimeSource = source === 'overtime';
  const sourceScopePerms = isOvertimeSource
    ? ['report:view:overtime', 'report:view:all']
    : ['report:view:self', 'report:view:group', 'report:view:department', 'report:view:project', 'report:view:all'];
  const perms = await accessPolicy.getPermissionCodes(viewer.id);
  const hasAnyReportView = sourceScopePerms.some((code) => perms.has(code));

  // 无该 source 的任何报表权限：overtime 源拒绝（加班无 self 兜底）；timesheet 源回退本人
  if (!hasAnyReportView) {
    if (isOvertimeSource) {
      return { effective: filters, matchAnyScope: false, denyAll: true };
    }
    return selfOnlyScope(viewer, filters);
  }

  // 按 source 选择求可访问集的权限码：overtime 源三轴都用 report:view:overtime；timesheet 源按轴类型
  const axisPerms = isOvertimeSource ? ['report:view:overtime'] : null;
  const [accessibleDept, accessibleGroup, accessibleProject] = await Promise.all([
    accessPolicy.getAccessibleDepartmentIds(viewer, axisPerms ?? ['report:view:department']),
    accessPolicy.getAccessibleGroupIds(viewer, axisPerms ?? ['report:view:group']),
    accessPolicy.getAccessibleProjectIds(viewer, axisPerms ?? ['report:view:project']),
  ]);

  // 任一轴返回 null 表示该轴完全开放（如 global 授权）→ 不裁剪，原样使用请求 filters
  if (accessibleDept === null || accessibleGroup === null || accessibleProject === null) {
    return emptyResult();
  }

  const requestedDept = filters.departmentIds?.length ? filters.departmentIds : undefined;
  const requestedGroup = filters.groupIds?.length ? filters.groupIds : undefined;
  const requestedProject = filters.projectIds?.length ? filters.projectIds : undefined;
  const requestedOrg = requestedDept || requestedGroup || requestedProject;

  const deptIds = intersectOr(requestedDept, accessibleDept);
  const groupIds = intersectOr(requestedGroup, accessibleGroup);
  const projectIds = intersectOr(requestedProject, accessibleProject);

  // 显式请求了组织过滤 → AND 合并；任一求交为空 = 越权请求 → denyAll
  if (requestedOrg) {
    const clippedEmpty =
      (requestedDept && deptIds.length === 0) ||
      (requestedGroup && groupIds.length === 0) ||
      (requestedProject && projectIds.length === 0);
    if (clippedEmpty) {
      return { effective: filters, matchAnyScope: false, denyAll: true };
    }
    return {
      effective: {
        ...filters,
        // 仅把用户显式请求的组织轴写回；未请求的轴不参与裁剪，避免多轴权限用户只请求一个轴时
        // 被偷偷 AND 进其它轴（如部门负责人请求 dept 却被 group 裁掉跨组数据）。
        departmentIds: requestedDept ? (deptIds.length ? deptIds : undefined) : undefined,
        groupIds: requestedGroup ? (groupIds.length ? groupIds : undefined) : undefined,
        projectIds: requestedProject ? (projectIds.length ? projectIds : undefined) : undefined,
      },
      matchAnyScope: false,
      denyAll: false,
    };
  }

  // 未请求组织过滤 → 用可访问集作为范围
  const activeAxes = [deptIds, groupIds, projectIds].filter((ids) => ids.length > 0);
  if (activeAxes.length === 0) {
    // 有报表码但所有组织轴可访问集均为空（如仅有 report:view:self）→ 回退本人
    return selfOnlyScope(viewer, filters);
  }
  return {
    effective: {
      ...filters,
      departmentIds: deptIds.length ? deptIds : undefined,
      groupIds: groupIds.length ? groupIds : undefined,
      projectIds: projectIds.length ? projectIds : undefined,
    },
    matchAnyScope: activeAxes.length > 1,
    denyAll: false,
  };
}

/** 仅本人可见：把 userIds 限定为 viewer.id。若请求了其他用户则求交为空 → denyAll。 */
function selfOnlyScope(viewer: AccessViewer, filters: ReportQueryFilters): ComputedScope {
  const requested = filters.userIds?.length ? filters.userIds : undefined;
  if (requested) {
    const clipped = requested.filter((id) => id === viewer.id);
    if (!clipped.length) {
      return { effective: filters, matchAnyScope: false, denyAll: true };
    }
    return {
      effective: { ...filters, userIds: [viewer.id] },
      matchAnyScope: false,
      denyAll: false,
    };
  }
  return {
    effective: { ...filters, userIds: [viewer.id] },
    matchAnyScope: false,
    denyAll: false,
  };
}

// ===================== 引擎 =====================

export class ReportQueryEngine {
  constructor(private manager?: EntityManager) {}

  private getManager() {
    return this.manager ?? AppDataSource;
  }

  /**
   * 创建带统一 WHERE 条件的基础查询（日期 / 状态 / 加班类型 / 可见范围裁剪 / userIds）。
   * 主聚合与 distinctUsers 合计查询复用同一套条件，保证口径一致。
   *
   * 安全：所有 id 列表用 IN (:...name) 参数化，不拼接字面量。
   */
  private buildBaseQuery(
    source: ReportSource,
    config: ReportQueryConfig,
    scope: ComputedScope,
  ): SelectQueryBuilder<any> {
    const manager = this.getManager();
    const alias = source === 'timesheet' ? 't' : 'o';
    const repo = source === 'timesheet'
      ? manager.getRepository(Timesheet)
      : manager.getRepository(OvertimeApplication);
    const qb = repo.createQueryBuilder(alias) as SelectQueryBuilder<any>;
    // 通过实体关系 JOIN users / projects，用于 user/project 维度的标签展示
    qb.leftJoin(`${alias}.user`, 'u');
    qb.leftJoin(`${alias}.project`, 'p');

    // 日期范围（已在 validateReportQueryConfig 内校验格式与跨度）
    qb.andWhere(`${alias}."date" BETWEEN :rqStart AND :rqEnd`, {
      rqStart: config.startDate,
      rqEnd: config.endDate,
    });

    // 状态过滤
    const eff = scope.effective;
    if (eff.statuses?.length) {
      qb.andWhere(`${alias}."status" IN (:...rqStatuses)`, { rqStatuses: eff.statuses });
    }

    // 工时版本去重（仅 timesheet 源；加班无版本链）：
    // 审批修改会产生同 (userId, projectId, date) 的多个版本（旧版本 deprecated 前并存）。
    // 与报表标准口径（dedupReportTimesheets / 超投 loadOverrunBase）一致：保留所选状态集合内的
    // 最大 submissionGroupId 行；无组号的历史行仅在不存在带组号行时保留。避免同一工时被重复求和。
    // 用 LEFT JOIN 聚合派生表实现（非相关子查询），pg-mem / PostgreSQL / SQLite 均支持。
    if (source === 'timesheet') {
      const scopeSql = this.buildScopeSql('t2', eff, scope.matchAnyScope);
      const userIdsSql = eff.userIds?.length ? ` AND t2."userId" IN (:...rqUserIds)` : '';
      const dedupSub = `(
        SELECT t2."userId" AS "dedupUserId", t2."projectId" AS "dedupProjectId", t2."date" AS "dedupDate",
               MAX(t2."submissionGroupId") AS "dedupMaxGroup"
        FROM timesheets t2
        WHERE t2."submissionGroupId" IS NOT NULL
          AND t2."date" BETWEEN :rqStart AND :rqEnd
          AND t2."status" IN (:...rqStatuses)${scopeSql ? ` AND ${scopeSql}` : ''}${userIdsSql}
        GROUP BY t2."userId", t2."projectId", t2."date"
      )`;
      qb.leftJoin(dedupSub, 'tmax',
        `"t"."userId" = tmax."dedupUserId" AND "t"."projectId" = tmax."dedupProjectId" AND "t"."date" = tmax."dedupDate"`);
      qb.andWhere(`(
        ("t"."submissionGroupId" IS NOT NULL AND "t"."submissionGroupId" = tmax."dedupMaxGroup")
        OR ("t"."submissionGroupId" IS NULL AND tmax."dedupMaxGroup" IS NULL)
      )`);
    }

    // overtimeType 过滤（仅 overtime 源；validateReportQueryConfig 已阻止误用）
    if (source === 'overtime' && eff.overtimeTypes?.length) {
      qb.andWhere(`${alias}."overtimeType" IN (:...rqOtTypes)`, { rqOtTypes: eff.overtimeTypes });
    }

    // 组织轴可见范围裁剪（部门 / 组 / 项目）
    const scopeSql = this.buildScopeSql(alias, eff, scope.matchAnyScope);
    if (scopeSql) {
      const params: Record<string, number[]> = {};
      const axes = this.scopeAxes(eff);
      axes.forEach((axis, i) => { params[`rqScope${i}`] = axis.ids; });
      qb.andWhere(scopeSql, params);
    }

    // userIds 过滤：始终 AND（组织轴已在 SQL 层约束，防止跨范围查看他人）
    if (eff.userIds?.length) {
      qb.andWhere(`${alias}."userId" IN (:...rqUserIds)`, { rqUserIds: eff.userIds });
    }

    return qb;
  }

  private scopeAxes(eff: ReportQueryFilters): { col: string; ids: number[] }[] {
    const axes: { col: string; ids: number[] }[] = [];
    if (eff.departmentIds?.length) axes.push({ col: 'departmentSnapshotId', ids: eff.departmentIds });
    if (eff.groupIds?.length) axes.push({ col: 'groupSnapshotId', ids: eff.groupIds });
    if (eff.projectIds?.length) axes.push({ col: 'projectId', ids: eff.projectIds });
    return axes;
  }

  /**
   * 组织轴范围过滤条件 SQL 片段（主查询与去重聚合子查询共用，参数名一致避免两处漂移）。
   * 返回纯条件（不带 AND 前缀）：andWhere 会自动加 AND；拼接进子查询字符串时调用方自行加 AND。
   * 单轴用 IN；多轴时 matchAnyScope=true 用 OR（可访问集并集），否则 AND（用户主动收窄）。
   */
  private buildScopeSql(alias: string, eff: ReportQueryFilters, matchAnyScope: boolean): string {
    const axes = this.scopeAxes(eff);
    if (!axes.length) return '';
    if (axes.length === 1) {
      return `${alias}."${axes[0].col}" IN (:...rqScope0)`;
    }
    const parts = axes.map((a, i) => `${alias}."${a.col}" IN (:...rqScope${i})`);
    return matchAnyScope
      ? `(${parts.join(' OR ')})`
      : `(${parts.join(' AND ')})`;
  }

  async run(configInput: unknown, viewer: AccessViewer): Promise<ReportQueryResult> {
    const config = validateReportQueryConfig(configInput);
    const accessPolicy = new AccessPolicyService(this.manager);
    const scope = await computeScope(accessPolicy, viewer, config.filters ?? {}, config.source);

    const hasSumDays = config.measures.includes('sumDays');
    const hasCount = config.measures.includes('count');
    const hasDistinctUsers = config.measures.includes('distinctUsers');
    const additive: ReportMeasure[] = [];
    if (hasSumDays) additive.push('sumDays');
    if (hasCount) additive.push('count');

    // 越权请求 → 直接返回空结果
    if (scope.denyAll) {
      return emptyResult(config.measures);
    }

    const rowDim = dimensionExpr(config.source, config.rowDimension);
    const colDim = config.colDimension ? dimensionExpr(config.source, config.colDimension) : null;

    // ----- 主聚合查询 -----
    const mainQb = this.buildBaseQuery(config.source, config, scope);
    const selectColumns: string[] = [
      `${rowDim.keyExpr} AS "rowKey"`,
      `${rowDim.labelExpr} AS "rowLabel"`,
    ];
    if (colDim) {
      selectColumns.push(`${colDim.keyExpr} AS "colKey"`);
      selectColumns.push(`${colDim.labelExpr} AS "colLabel"`);
    }
    for (const m of config.measures) {
      selectColumns.push(`${measureExpr(config.source, m)} AS "${m}"`);
    }
    mainQb.select(selectColumns);
    mainQb.groupBy(rowDim.keyExpr);
    mainQb.addGroupBy(rowDim.labelExpr);
    if (colDim) {
      mainQb.addGroupBy(colDim.keyExpr);
      mainQb.addGroupBy(colDim.labelExpr);
    }
    mainQb.orderBy(rowDim.keyExpr).addOrderBy(colDim ? colDim.keyExpr : rowDim.keyExpr);

    const rawRows = await mainQb.getRawMany<Record<string, unknown>>();

    // ----- 组装 cells / keys -----
    const rowKeyMap = new Map<string, string>();
    const colKeyMap = new Map<string, string>();
    const cells: Record<string, Record<string, ReportCellMeasures>> = {};

    for (const raw of rawRows) {
      const rk = String(raw.rowKey ?? '');
      const rl = raw.rowLabel == null ? '' : String(raw.rowLabel);
      if (!rowKeyMap.has(rk)) rowKeyMap.set(rk, rl);
      const ck = colDim ? String(raw.colKey ?? '') : TOTAL_COL;
      const cl = colDim ? (raw.colLabel == null ? '' : String(raw.colLabel)) : '';
      if (colDim && !colKeyMap.has(ck)) colKeyMap.set(ck, cl);

      const cell: ReportCellMeasures = {};
      if (hasSumDays) cell.sumDays = round2(Number(raw.sumDays ?? 0));
      if (hasCount) cell.count = Number(raw.count ?? 0);
      if (hasDistinctUsers) cell.distinctUsers = Number(raw.distinctUsers ?? 0);

      if (!cells[rk]) cells[rk] = {};
      cells[rk][ck] = cell;
    }

    // ----- 可加量度 totals（sumDays / count）：由 cells 累加 -----
    const rowTotals: Record<string, ReportCellMeasures> = {};
    const colTotals: Record<string, ReportCellMeasures> = {};
    const grandTotal: ReportCellMeasures = {};
    const colKeysForTotal = colDim ? Array.from(colKeyMap.keys()) : [TOTAL_COL];

    for (const rk of rowKeyMap.keys()) {
      const total: ReportCellMeasures = {};
      const rowCells = cells[rk] || {};
      for (const m of additive) {
        total[m] = round2(
          Object.values(rowCells).reduce((sum, c) => sum + Number(c[m] ?? 0), 0),
        );
      }
      rowTotals[rk] = total;
    }
    for (const ck of colKeysForTotal) {
      const total: ReportCellMeasures = {};
      for (const m of additive) {
        total[m] = round2(
          Array.from(rowKeyMap.keys()).reduce(
            (sum, rk) => sum + Number(cells[rk]?.[ck]?.[m] ?? 0),
            0,
          ),
        );
      }
      colTotals[ck] = total;
    }
    for (const m of additive) {
      grandTotal[m] = round2(
        Array.from(rowKeyMap.keys()).reduce((sum, rk) => sum + Number(rowTotals[rk][m] ?? 0), 0),
      );
    }

    // ----- distinctUsers totals：不可由 cells 加总，需独立 COUNT(DISTINCT) 查询 -----
    if (hasDistinctUsers) {
      // 行合计
      const rowDistinctQb = this.buildBaseQuery(config.source, config, scope);
      rowDistinctQb.select([
        `${rowDim.keyExpr} AS "rowKey"`,
        `${measureExpr(config.source, 'distinctUsers')} AS "cnt"`,
      ]);
      rowDistinctQb.groupBy(rowDim.keyExpr);
      const rowDistinct = await rowDistinctQb.getRawMany<{ rowKey: unknown; cnt: unknown }>();
      for (const r of rowDistinct) {
        const rk = String(r.rowKey ?? '');
        if (!rowTotals[rk]) rowTotals[rk] = {};
        rowTotals[rk].distinctUsers = Number(r.cnt ?? 0);
      }

      // 列合计
      if (colDim) {
        const colDistinctQb = this.buildBaseQuery(config.source, config, scope);
        colDistinctQb.select([
          `${colDim.keyExpr} AS "colKey"`,
          `${measureExpr(config.source, 'distinctUsers')} AS "cnt"`,
        ]);
        colDistinctQb.groupBy(colDim.keyExpr);
        const colDistinct = await colDistinctQb.getRawMany<{ colKey: unknown; cnt: unknown }>();
        for (const r of colDistinct) {
          const ck = String(r.colKey ?? '');
          if (!colTotals[ck]) colTotals[ck] = {};
          colTotals[ck].distinctUsers = Number(r.cnt ?? 0);
        }
      } else {
        colTotals[TOTAL_COL].distinctUsers = 0; // 单列时与 grandTotal 一致，下方统一回填
      }

      // 总合计
      const grandQb = this.buildBaseQuery(config.source, config, scope);
      grandQb.select([`${measureExpr(config.source, 'distinctUsers')} AS "cnt"`]);
      const grandRow = await grandQb.getRawOne<{ cnt: unknown }>();
      const grandDistinct = Number(grandRow?.cnt ?? 0);
      grandTotal.distinctUsers = grandDistinct;
      if (!colDim) colTotals[TOTAL_COL].distinctUsers = grandDistinct;
    }

    return {
      rowKeys: Array.from(rowKeyMap.entries()).map(([key, label]) => ({ key, label })),
      colKeys: (colDim ? Array.from(colKeyMap.entries()) : [[TOTAL_COL, '']]).map(
        ([key, label]) => ({ key, label }),
      ),
      cells,
      rowTotals,
      colTotals,
      grandTotal,
    };
  }
}

function emptyResult(measures: ReportMeasure[]): ReportQueryResult {
  const grandTotal: ReportCellMeasures = {};
  for (const m of measures) {
    if (m === 'sumDays') grandTotal.sumDays = 0;
    else if (m === 'count') grandTotal.count = 0;
    else if (m === 'distinctUsers') grandTotal.distinctUsers = 0;
  }
  return {
    rowKeys: [],
    colKeys: [{ key: TOTAL_COL, label: '' }],
    cells: {},
    rowTotals: {},
    colTotals: {},
    grandTotal,
  };
}
