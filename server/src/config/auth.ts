import dotenv from 'dotenv';

dotenv.config();

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET 未配置，请在环境变量或 .env 中设置强随机密钥');
}
// 强度校验：拒绝已知弱密钥/占位符/过短密钥，防止生产误用
const WEAK_SECRETS = new Set([
  'replace-with-a-long-random-secret',
  'worktime-jwt-secret-key-2026',
  'secret',
  'jwt-secret',
  'your-secret-key',
  'changeme',
]);
if (WEAK_SECRETS.has(jwtSecret)) {
  throw new Error(`JWT_SECRET 是已知的弱密钥/占位符（${jwtSecret}），请生成一个至少 32 字符的随机密钥`);
}
if (jwtSecret.length < 16) {
  throw new Error(`JWT_SECRET 长度不足（${jwtSecret.length} 字符），请使用至少 32 字符的随机密钥`);
}

export const authConfig = {
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
};

