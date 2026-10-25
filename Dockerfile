FROM node:24.22.1-alpine AS deps
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS builder
RUN pnpm run build

FROM node:24.22.1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV WEAVER_PORT=3399

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
RUN pnpm install --frozen-lockfile --prod

EXPOSE 3399
CMD ["pnpm", "--filter", "@weaver-conf/weaver-server", "run", "start"]
