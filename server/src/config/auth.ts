import dotenv from 'dotenv';

dotenv.config();

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET 未配置，请在环境变量或 .env 中设置强随机密钥');
}

export const authConfig = {
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
};

