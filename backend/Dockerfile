# Backend — Node 24 Debian (native canvas + Chromium support on ARM64/AMD64)
# Used by docker compose for a fully containerized local stack (Option B).

FROM node:24-bookworm-slim

# canvas falls back to node-gyp on platforms without prebuilt binaries.
# Debian provides Chromium on ARM64, where Puppeteer's browser download does not.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    chromium fonts-liberation ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma schema + client generation
COPY prisma ./prisma/
RUN npx prisma generate

# Application code
COPY . .

# Health check
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

EXPOSE 3000

CMD ["node", "server.js"]
