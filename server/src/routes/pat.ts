import { Router } from 'express';
import { PatService } from '../services/patService';
import { AuditService } from '../services/auditService';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { BusinessError } from '../utils/errors';
import { parseOptionalDateTime, parsePositiveInt, parseString } from '../utils/validation';
import { permissionDefinitions } from '../config/permissionDefinitions';

const router = Router();
const patService = new PatService();
const auditService = new AuditService();

/** 合法 PAT scope 集合（权限目录的全部权限码） */
const validPatScopes = new Set(permissionDefinitions.map((d) => d.code));

// PAT 管理本身只走 JWT 会话鉴权（不能用 PAT 管 PAT，避免令牌自管带来的循环依赖）
router.use(authMiddleware);
export function requireJwtSession(req: AuthRequest, _res: unknown, next: (error?: unknown) => void) {
  if (req.authMethod !== 'jwt') return next(new BusinessError('个人访问令牌只能通过登录会话管理', 403, 403));
  next();
}

router.use(requireJwtSession);

/** 列出当前用户所有 PAT（仅元数据和脱敏前缀，不返回 hash/明文） */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const list = await patService.listMine(req.user!.id);
    res.json({ code: 0, data: list });
  } catch (error) {
    next(error);
  }
});

/** 可选 PAT scope（权限码）目录：创建令牌时供前端勾选收窄权限 */
router.get('/scopes', async (_req: AuthRequest, res, next) => {
  try {
    const scopes = permissionDefinitions
      .map((d) => ({ code: d.code, name: d.name }))
      .sort((a, b) => a.code.localeCompare(b.code));
    res.json({ code: 0, data: scopes });
  } catch (error) {
    next(error);
  }
});

/** 创建新 PAT */
router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const expiresAt = parseOptionalDateTime(body.expiresAt, '过期时间');
    // scope 收窄：可选的权限码数组（空 = 继承用户全部权限）。
    // 与 GET /pats/scopes 返回的合法权限码对照，未知权限码直接拒绝。
    const rawScopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [];
    const unknown = rawScopes.filter((s) => !validPatScopes.has(s));
    if (unknown.length) {
      throw new BusinessError(`无效的权限范围：${unknown.join('、')}`);
    }
    const pat = await patService.createMine(
      req.user!.id,
      parseString(body.name, '令牌名称', { required: true, max: 100 })!,
      expiresAt ? new Date(expiresAt) : undefined,
      rawScopes,
    );
    auditService.log({
      userId: req.user!.id,
      action: 'pat:create',
      target: 'personal_access_token',
      targetId: pat.id,
      detail: pat.name,
      ip: req.ip,
    });
    // 不返回 tokenHash（列表接口同样已排除）：令牌明文只需 tokenPlain 一次
    const { tokenHash: _omit, ...safe } = pat;
    res.json({ code: 0, data: safe, message: '令牌已创建' });
  } catch (error) {
    next(error);
  }
});

/** 删除 PAT（仅限本人） */
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id, '令牌 ID');
    await patService.deleteMine(req.user!.id, id);
    auditService.log({
      userId: req.user!.id,
      action: 'pat:delete',
      target: 'personal_access_token',
      targetId: id,
      ip: req.ip,
    });
    res.json({ code: 0, message: '令牌已删除' });
  } catch (error) {
    next(error);
  }
});

export const patRoutes = router;
