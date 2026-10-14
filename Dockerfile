# --- Build stage --------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

RUN npm prune --omit=dev --no-audit --no-fund

# --- Runtime stage ------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY migrations/ migrations/
COPY public/ public/
COPY skills/ skills/
COPY package.json ./

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]
