# Backend — Node 20 Alpine
# Used by docker compose for a fully containerized local stack (Option B).

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY package.json package-lock.json ./
RUN npm install

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
