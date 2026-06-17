import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * 包裹 async 路由 handler：捕获 reject 后转交 Express 错误中间件。
 * 这样路由层无需再写 try/catch，业务代码直接 throw BusinessError 即可。
 *
 * 用法：
 *   router.get('/x', asyncHandler(async (req, res) => {
 *     if (!valid) throw new BusinessError('参数错误');
 *     res.json({ code: 0, data });
 *   }));
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}
