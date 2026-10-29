# syntax=docker/dockerfile:1

# ============================================================
# 构建阶段：装全量依赖 → 编译 TypeScript
# ============================================================
FROM node:22-slim AS builder

WORKDIR /app

# 先只拷依赖清单，这样只要源码没变，npm ci 这一层就一直命中缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ============================================================
# 运行阶段：只留运行时依赖 + 编译产物 + 前端静态资源
# ============================================================
FROM node:22-slim AS runtime

# AI_TODO_HOST 必须是 0.0.0.0，否则容器外面连不上
# AI_TODO_DATA_DIR / AI_TODO_WEB_DIR 传绝对路径：
#   config.ts 里是 resolve(packageRoot, <值>)，绝对路径会被原样保留
ENV NODE_ENV=production \
    AI_TODO_HOST=0.0.0.0 \
    AI_TODO_PORT=8787 \
    AI_TODO_DATA_DIR=/app/data \
    AI_TODO_WEB_DIR=/app/web

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY web ./web

# data 目录归属 node 用户。命名卷首次挂载时会继承镜像里该路径的内容与属主，
# 因此容器以非 root 运行时依然能往 /app/data 里写凭据文件与数据库文件。
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

CMD ["node", "dist/src/cli.js", "serve"]
