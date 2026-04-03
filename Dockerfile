# Paperclip -- Autonomous AI Operations Layer for BenefitsSafe
# Deploy to AWS ECS/Fargate as a long-running service

FROM node:20-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# Generate Prisma client
FROM deps AS prisma
COPY prisma ./prisma/
RUN npx prisma generate

# Build TypeScript
FROM prisma AS builder
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Production image
FROM base AS runner
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/generated ./src/generated

# Health check -- agent writes heartbeat to /tmp/paperclip-health
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD test -f /tmp/paperclip-health && \
      test $(($(date +%s) - $(stat -c %Y /tmp/paperclip-health 2>/dev/null || echo 0))) -lt 300

USER node
CMD ["node", "dist/index.js"]
