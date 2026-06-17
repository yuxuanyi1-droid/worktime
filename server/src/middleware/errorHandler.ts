import { Request, Response, NextFunction } from 'express';
import { isBusinessError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * 统一错误处理中间件。
 *
 * - BusinessError：业务错误，statusCode + message 均对前端安全暴露。
 * - 其它 Error：系统错误，仅返回 500 + "服务器内部错误"；结构化记录到日志（含堆栈），
 *   仅在 NODE_ENV=development 时回显 message（便于本地调试）。
 */
export const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (isBusinessError(err)) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
    });
  }

  // 系统错误：结构化记录（method/url/stack），但不对前端暴露内部细节
  logger.error(
    { err, method: req.method, url: req.originalUrl },
    `未捕获错误: ${err.message}`,
  );
  return res.status(500).json({
    code: 500,
    message: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误',
  });
};
