import express, { type Router } from 'express';
import { errorHandler } from '@server/middleware/errorHandler';

/** 为单个路由模块创建最小 Express 应用，验证参数、权限和响应契约。 */
export function createRouteTestApp(basePath: string, router: Router) {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  app.use(errorHandler);
  return app;
}
