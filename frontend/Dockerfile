# Frontend — multi-stage build
# Stage 1: Build static assets with Vite
# Stage 2: Serve with nginx + proxy /api to backend

# ── Build stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Dependencies
COPY package.json package-lock.json ./
RUN npm install

# Source + build
COPY . .

# Build args for env injection at build time
ARG VITE_RAZORPAY_KEY_ID
ENV VITE_RAZORPAY_KEY_ID=${VITE_RAZORPAY_KEY_ID}

RUN npm run build

# ── Serve stage ────────────────────────────────────────────────────────────
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Custom nginx config (proxies /api to backend)
COPY nginx.conf /etc/nginx/conf.d/

# Static assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
