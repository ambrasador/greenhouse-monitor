# Версія образу задається тут і оновлюється свідомо
# (для випуску додають @sha256:…)
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# 1. Залежності production: лише потрібне під час виконання, строго за
#    lock-файлом
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# 2. Клієнт: esbuild, React і recharts потрібні лише для збирання
#    і у фінальний образ не потрапляють
FROM ${NODE_IMAGE} AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY client ./client
RUN npm run build:client

# 3. Сервер: дозволені .dockerignore модулі, залежності з кроку 1,
#    користувач без прав root
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/greenhouse.db
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY *.js *.sql package.json ./
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  --start-interval=1s --retries=3 CMD ["node", "healthcheck.js"]
CMD ["node", "main.js"]

# 4. Вебсервер: статичний клієнт і проксі до сервера
FROM nginx:1.30.6-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=client /app/client/dist /usr/share/nginx/html
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  --start-interval=1s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1/"]
