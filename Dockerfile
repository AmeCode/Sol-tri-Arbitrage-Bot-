# ---- build stage: has dev deps & compiles TS ----
FROM node:20-slim AS builder
WORKDIR /app

# install ALL deps (including dev) so tsc has type defs
COPY package.json package-lock.json* ./
RUN npm ci

COPY .env .
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: prod-only, no dev deps ----
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# install ONLY prod deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# copy compiled JS only
COPY --from=builder /app/dist ./dist

# start compiled app
CMD ["node", "--enable-source-maps", "dist/index.js"]

