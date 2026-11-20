# 使用 BuildKit 内置语法解析器，避免构建前额外拉取 docker/dockerfile 镜像。

# ===== 后端构建：安装依赖（含原生模块编译） =====
FROM node:22-bookworm AS backend-build
WORKDIR /build/backend
# 与运行镜像一样使用系统 FFmpeg，避免 npm 安装时另从 GitHub 下载静态二进制。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_BIN=/usr/bin/ffmpeg FFPROBE_BIN=/usr/bin/ffprobe
COPY backend/package.json backend/package-lock.json ./
RUN node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json'));for(const p of Object.values(l.packages||{}))delete p.resolved;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2))" \
  && npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org
COPY backend/ ./
# 后端通过生产依赖 tsx 运行；完全沿用锁文件，不在构建时额外解析/补装依赖。

# ===== 前端构建：Nuxt generate 产出静态站点 =====
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
# lockfile 的 resolved 可能指向带鉴权的私有 registry（开发者本机 .npmrc），镜像内会 401。
# 构建期删除 resolved 字段（integrity 校验不受影响），让 npm 统一走公共 registry
RUN node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json'));for(const p of Object.values(l.packages||{}))delete p.resolved;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2))" \
  && npm ci --no-audit --no-fund --registry=https://registry.npmjs.org
COPY frontend/ ./
# 剧本转视频页面导入后端的共享类型、模型能力和分镜校验代码。
COPY --from=backend-build /build/backend/src /build/backend/src
COPY --from=backend-build /build/backend/node_modules /build/backend/node_modules
COPY --from=backend-build /build/backend/workspace/skills/script-to-video/scripts /build/backend/workspace/skills/script-to-video/scripts
RUN npm run generate

# ===== 运行时 =====
FROM node:22-bookworm-slim
ARG HUOBAO_VERSION=dev
ENV NODE_ENV=production \
    HUOBAO_VERSION=${HUOBAO_VERSION} \
    PORT=5679 \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    HUOBAO_DATA_DIR=/app/data \
    SQLITE_PATH=/app/data/huobao.sqlite3 \
    WORKSPACE_PATH=/app/data/workspace \
    FRONTEND_DIST=/app/frontend-dist

# ffprobe-static 不包含 Linux ARM64 二进制；两个架构统一使用系统媒体工具。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-build /build/backend/src ./backend/src
COPY --from=backend-build /build/backend/node_modules ./backend/node_modules
COPY --from=backend-build /build/backend/package.json ./backend/package.json
COPY --from=backend-build /build/backend/tsconfig.json ./backend/tsconfig.json
# workspace 模板（skills/prompts），entrypoint copy-once 到数据卷后可在线编辑
COPY backend/workspace ./workspace-template
RUN ln -s /app/workspace-template ./backend/workspace
COPY --from=frontend-build /build/frontend/.output/public ./frontend-dist
COPY docker/entrypoint.sh ./entrypoint.sh
# Windows 检出可能使用 CRLF，先转换换行，确保 Linux 能识别 shebang。
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod +x ./entrypoint.sh && mkdir -p /app/data

# 数据卷：SQLite + 生成的静态文件 + 可编辑 workspace
VOLUME ["/app/data"]
EXPOSE 5679

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||5679)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
