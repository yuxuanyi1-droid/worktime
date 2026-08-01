// 测试环境统一注入 JWT_SECRET。
// server/src/config/auth.ts 在模块加载期对 JWT_SECRET 做必填/强度校验（缺失或弱密钥直接 throw），
// 而服务端测试大量文件会传递依赖加载 config/auth（authMiddleware、各 service、routes 等）。
// 无根 .env 的 CI 环境必须在这里预置固定测试密钥，避免测试进程启动即崩溃。
// 固定值仅用于测试签名，与任何生产密钥无关；用 ??= 保留外部显式注入的覆盖能力。
process.env.JWT_SECRET ??= '29e5f5985fbd0b8e3a4a192fa35553bdd0c50e42129a5004f9f417c685e26cd6';
