# Веб-клиент Calab: сборка SPA (apps/desktop -> dist-web) и раздача через nginx.
# Заменяет статическую часть Caddyfile стенда. Контекст сборки — корень репо.
#   docker build -f infra/dokploy/web/Dockerfile -t calab-web .

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# --ignore-scripts: нативный uiohook-napi и загрузка бинарника Electron вебу не нужны
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm -F @calaba/desktop build:web

FROM nginx:alpine
# *.template рендерится envsubst-ом при старте (нужна переменная DOMAIN)
COPY infra/dokploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/desktop/dist-web /usr/share/nginx/html
