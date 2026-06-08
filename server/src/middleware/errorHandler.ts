import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[Error]', err.message, err.stack);
  res.status(500).json({
    code: 500,
    message: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误',
  });
};
