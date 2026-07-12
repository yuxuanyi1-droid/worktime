import dotenv from 'dotenv';
import path from 'path';

// 集中加载环境变量，保证进程入口（app.ts / seed.ts / 测试等）统一初始化。
//
// 所有配置统一在仓库根 .env（前后端共享：端口/JWT/DB/OIDC 等全在一处）。
// 前端 vite 也通过 loadEnv 读取同一个根 .env。
//
// 路径解析依赖 __dirname：
//   - dev（tsx 运行 src/config/env.ts）：__dirname = server/src/config  → ../../../.env = 仓库根
//   - build（node dist/config/env.js）：__dirname = server/dist/config → ../../../.env = 仓库根
// 两套运行方式下三级向上都指向仓库根，路径一致。
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
