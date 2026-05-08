import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

// #634: build-time version + commit-sha injection so the app shell footer can
// show a build identifier ("v3.4.14 · f5453fc"). Source-of-truth for the
// version is backend/package.json (per the 44747b4 standing rule — /api/health
// reads from the same file). The frontend package.json may drift out of sync;
// reading the canonical backend file keeps both surfaces aligned.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readBackendVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../backend/package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitSha() {
  // Prefer an explicit env var (CI may inject one without git available);
  // fall back to git rev-parse. Empty string if neither works — the footer
  // gracefully degrades to version-only.
  if (process.env.VITE_GIT_SHA) return process.env.VITE_GIT_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    return '';
  }
}

const APP_VERSION = readBackendVersion();
const APP_GIT_SHA = readGitSha();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_GIT_SHA__: JSON.stringify(APP_GIT_SHA),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path,
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-charts': ['recharts'],
          'vendor-flow': ['reactflow'],
          'vendor-icons': ['lucide-react']
        }
      }
    },
    chunkSizeWarningLimit: 800
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    css: false,
  },
})
