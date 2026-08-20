FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS builder
RUN apk add --no-cache openssl git
WORKDIR /app

COPY . .

# Install deps — @prisma/engines postinstall will download the musl binary (Alpine)
RUN pnpm install --no-frozen-lockfile

# Generate Prisma client
WORKDIR /app/apps/whatsapp-engine
RUN pnpm exec prisma generate

WORKDIR /app
RUN pnpm --filter @wasil/encryption build
RUN pnpm --filter @wasil/whatsapp-engine build
RUN pnpm deploy --filter @wasil/whatsapp-engine --prod /prod/whatsapp-engine

# Regenerate Prisma client inside the prod directory so it lands in the correct
# pnpm virtual-store path (the path varies by version hash and can't be hardcoded)
RUN cp -r /app/apps/whatsapp-engine/prisma /prod/whatsapp-engine/ && \
    cd /prod/whatsapp-engine && \
    pnpm dlx prisma@6.19.2 generate --schema prisma/schema.prisma

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg openssl

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 engine

COPY --from=builder --chown=engine:nodejs /prod/whatsapp-engine .

# Copy prisma schema (needed at runtime)
COPY --from=builder --chown=engine:nodejs /app/apps/whatsapp-engine/prisma ./prisma

# Run as root to support local docker-compose volume mounts freely
# USER engine

EXPOSE 3001

CMD ["node", "dist/index.js"]
