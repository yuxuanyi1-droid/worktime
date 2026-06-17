/**
 * 业务错误：可向前端暴露的错误（带用户可读的 message）。
 * 默认 statusCode = 400。路由层抛出此错误会被 errorHandler 统一处理为对应 HTTP 状态 + 业务文案。
 *
 * 与普通 Error 的区别：
 * - BusinessError 的 message 是安全的、用户可读的（如 "记录不存在"）
 * - 普通 Error 视为系统错误，message 不对前端暴露（仅返回 "服务器内部错误"），完整堆栈打到服务端日志
 */
export class BusinessError extends Error {
  readonly statusCode: number;
  readonly code: number;

  constructor(message: string, statusCode = 400, code?: number) {
    super(message);
    this.name = 'BusinessError';
    this.statusCode = statusCode;
    // 业务 code：默认与 statusCode 一致，保持与前端响应拦截器（data.code !== 0 即失败）兼容
    this.code = code ?? statusCode;
  }
}

export function isBusinessError(error: unknown): error is BusinessError {
  return error instanceof BusinessError;
}
