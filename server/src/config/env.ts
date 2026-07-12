import dotenv from 'dotenv';
import path from 'path';

// 集中加载环境变量，保证进程入口（app.ts / seed.ts / 测试等）统一初始化。
//
// 加载顺序（先加载的优先 —— dotenv 默认不覆盖已存在的 process.env）：
//   1) 仓库根 .env  —— 前后端端口单一真相源（PORT / CLIENT_PORT / BASE_PATH）
//   2) server/.env   —— JWT_SECRET / DB_PATH 等后端专属配置
//
// BASE_PATH：子路径部署前缀（如 /worktime），由根 .env 提供，app.ts 读取后拼接所有路由挂载点。
//             空 = 根路径部署；前端 vite 构建期也读同一个 BASE_PATH 注入 baseURL / basename。
//
// 路径解析依赖 __dirname：
//   - dev（tsx 运行 src/config/env.ts）：__dirname = server/src/config  → ../../../.env = 仓库根
//   - build（node dist/config/env.js）：__dirname = server/dist/config → ../../../.env = 仓库根
// 两套运行方式下三级向上都指向仓库根，路径一致。
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
