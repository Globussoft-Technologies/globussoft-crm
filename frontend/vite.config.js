import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readBackendVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../backend/package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readGitSha() {
  if (process.env.VITE_GIT_SHA) return process.env.VITE_GIT_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const APP_VERSION = readBackendVersion();
const APP_GIT_SHA = readGitSha();

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_GIT_SHA__: JSON.stringify(APP_GIT_SHA),
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:5000",
        changeOrigin: true,
        rewrite: (p) => p,
      },
      "/uploads": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:5000",
        changeOrigin: true,
        rewrite: (p) => p,
      },
      // Raw WebSocket endpoints served by Express (Callified agent bridge at
      // /ws/callified-agent). `ws: true` is what makes Vite forward the
      // upgrade handshake instead of answering with the SPA shell. socket.io
      // is untouched — it uses its own /socket.io path and its own client.
      "/ws": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:5000",
        changeOrigin: true,
        ws: true,
      },
      // Public landing pages (/p/<slug>) are server-rendered HTML
      // emitted by Express. In production Nginx routes /p/* to the
      // backend; in dev we need to proxy it explicitly, otherwise
      // Vite falls through to the SPA's 404 page. Excludes the SPA routes
      // under /p/ (itinerary, quote, payment-success, review, etc.) so the
      // React router can render them.
      "^/p/(?!(tripmicrosite|itinerary|tmc|quote|review|payment|flyer)(/|$))": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:5000",
        changeOrigin: true,
        rewrite: (p) => p,
      },
      "^/trips(?:/|$)": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:5000",
        changeOrigin: true,
        rewrite: (p) => p,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-charts": ["recharts"],
          "vendor-flow": ["reactflow"],
          "vendor-icons": ["lucide-react"],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.js"],
    css: false,
  },
});
