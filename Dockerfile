# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-alpine

# ---- build: compile TypeScript -------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: runtime dependencies only --------------------------------------------------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---- runtime: minimal, non-root ------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
