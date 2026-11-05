# --- Oberfläche (Vite/React) ---
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

# --- Server ---
# --ignore-scripts: better-sqlite3 (v13) liefert fertige Binärdateien mit; ein Kompilieren per node-gyp ist nicht nötig.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Laufzeit ---
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATABASE_PATH=/data/app.db \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./dist/public
COPY drizzle ./drizzle
RUN mkdir -p /data && chown -R node:node /data /app \
 && printf '#!/bin/sh\nexec node /app/dist/cli/create-user.js "$@"\n' > /usr/local/bin/create-user \
 && chmod +x /usr/local/bin/create-user
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
