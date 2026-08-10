# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json .eslintrc.json nest-cli.json ./
COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile
RUN pnpm run prisma:generate
RUN pnpm run build

# Production Stage
FROM node:22-alpine AS production

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json .eslintrc.json nest-cli.json ./
COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile --prod

RUN pnpm run prisma:generate
COPY --from=builder /app/apps/api-gateway/dist ./apps/api-gateway/dist

EXPOSE 3000

CMD ["node", "apps/api-gateway/dist/main.js"]
