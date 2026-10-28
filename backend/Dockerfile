# Backend — Node 20 Alpine
# Used by docker compose for a fully containerized local stack (Option B).

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY backend/package.json backend/package-lock.json ./
RUN npm install

# Prisma schema + client generation
COPY backend/prisma ./prisma/
RUN npx prisma generate

# Application code
COPY backend/ .

# The landing-page embed route resolves this document at
# /frontend/public/embed/web-form.html. Keep it in the backend image as well
# as the separately-built frontend image so Compose deployments can render
# the hero form without relying on files outside the container.
COPY frontend/public/embed/web-form.html /frontend/public/embed/web-form.html

# Health check
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

EXPOSE 3000

CMD ["node", "server.js"]
