# ---- 阶段1：构建前端 + 编译后端 ----
FROM node:20-alpine AS builder

WORKDIR /app

# 先复制 package 文件利用 docker 缓存
COPY package.json package-lock.json* ./
COPY server/package.json server/package-lock.json* ./server/
COPY client/package.json client/package-lock.json* ./client/

# 安装所有依赖（root + server + client）
RUN npm install --ignore-scripts
RUN cd server && npm install --ignore-scripts
RUN cd client && npm install --ignore-scripts

# 复制源码
COPY . .

# 构建：编译后端 TS → dist/，构建前端 → client/dist/
RUN cd server && npm run build
RUN cd client && npm run build

# 只保留 server 生产依赖
RUN cd server && npm prune --production

# ---- 阶段2：运行时（最小镜像） ----
FROM node:20-alpine AS runtime

WORKDIR /app

# 安装 tini 作为 init 进程（正确处理信号 + 僵尸进程）
RUN apk add --no-cache tini

# 复制后端编译产物 + 生产依赖（migrations 由 tsc 编译进 dist/migrations）
COPY --from=builder /app/server/package.json /app/server/package.json
COPY --from=builder /app/server/node_modules /app/server/node_modules
COPY --from=builder /app/server/dist /app/server/dist

# 复制前端构建产物（由反向代理如 nginx 托管，或 server 静态服务）
COPY --from=builder /app/client/dist /app/client/dist

# 数据持久化目录
RUN mkdir -p /app/server/data
VOLUME /app/server/data

ENV NODE_ENV=production
ENV DB_PATH=/app/server/data/worktime.db
ENV PORT=3000

EXPOSE 3000

WORKDIR /app/server

# tini 接管 PID 1，正确转发 SIGTERM 给 node（优雅关闭）
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/app.js"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
