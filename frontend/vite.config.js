import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
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

// #921 slice S4 (FR-3.6) — Subresource Integrity (SRI) plugin.
//
// Computes a SHA-384 hash of every JS chunk + CSS asset emitted by the
// build and injects `integrity="sha384-<base64>"` + `crossorigin="anonymous"`
// attributes onto the corresponding <script> / <link rel="stylesheet">
// tags in dist/index.html. With SRI in place, a CDN-poisoning or
// supply-chain attack that swaps a bundle file silently is detected by
// the browser — the loaded asset's actual hash won't match the integrity
// attribute, and the browser refuses to execute it.
//
// Implementation choice: inline plugin rather than `vite-plugin-sri`
// because (a) adding an npm dep costs an audit + lock-file churn for a
// ~40-line plugin; (b) the npm registry has multiple competing
// `vite-plugin-sri*` variants with conflicting maintenance status; (c)
// keeping the logic in-tree makes the SRI shape auditable in the same
// repo as the gate spec that verifies it.
//
// Algorithm: SHA-384 (the W3C SRI recommendation; SHA-256 also valid but
// less collision-resistant, SHA-512 valid but overkill). Base64-encoded.
// `crossorigin="anonymous"` is required by the SRI spec — without it the
// browser silently skips the integrity check for cross-origin assets.
//
// Coverage: only emitted (build-time) bundles get hashes. The
// `index.html`'s inline FOUC-prevention <script>...</script> block stays
// inline (no `src=`) so SRI doesn't apply — the strict CSP nonce work
// from slice S1 covers that surface. External CDN imports (none today,
// jsdelivr is allowed in CSP but the SPA doesn't actually load from
// there) would need a manual SRI hash by the author; that's out of scope
// for this slice.
function sriPlugin() {
  return {
    name: 'gbs-crm-sri',
    apply: 'build',
    // Run AFTER bundles are emitted but BEFORE the final HTML write. The
    // `transformIndexHtml` hook with `enforce: 'post'` ensures we see the
    // final asset filenames (hashes applied by Vite) — running earlier
    // would see pre-bundling paths.
    transformIndexHtml: {
      enforce: 'post',
      handler(html, ctx) {
        // ctx.bundle contains every emitted chunk + asset, keyed by the
        // final filename. We compute SHA-384 over each chunk/asset's
        // source bytes.
        if (!ctx || !ctx.bundle) return html;
        const integrityByFile = new Map();
        for (const [fileName, asset] of Object.entries(ctx.bundle)) {
          // 'chunk' = JS bundle; 'asset' = CSS or other static
          const source = asset.type === 'chunk' ? asset.code : asset.source;
          if (!source) continue;
          const buf = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source);
          const hash = createHash('sha384').update(buf).digest('base64');
          integrityByFile.set(fileName, `sha384-${hash}`);
        }
        // Inject integrity + crossorigin on every <script src="..."> and
        // <link rel="stylesheet" href="..."> whose source we hashed.
        //
        // Regex (not a full HTML parser) is fine here because Vite's emitted
        // index.html follows a strict shape — every script/link injected by
        // Vite is single-line with attribute order we control.
        // Strip any pre-existing `crossorigin` attribute on the tags we
        // rewrite to avoid emitting two copies (Vite sets one already on
        // module scripts and stylesheets). We re-add the canonical
        // `crossorigin="anonymous"` form which the SRI spec requires.
        function stripCrossorigin(attrs) {
          return attrs.replace(/\s+crossorigin(="[^"]*")?/gi, '');
        }
        let out = html.replace(
          /<script(\s[^>]*?)?\ssrc="\/?([^"]+)"([^>]*)><\/script>/g,
          (match, before, src, after) => {
            const cleaned = src.replace(/^\.?\/?/, '');
            const integrity = integrityByFile.get(cleaned);
            if (!integrity) return match;
            // Skip if already present (idempotent).
            if (/integrity=/.test(match)) return match;
            const cleanBefore = stripCrossorigin(before || '');
            const cleanAfter = stripCrossorigin(after || '');
            return `<script${cleanBefore} src="/${cleaned}" integrity="${integrity}" crossorigin="anonymous"${cleanAfter}></script>`;
          }
        );
        out = out.replace(
          /<link(\s[^>]*?)?\srel="stylesheet"([^>]*?)\shref="\/?([^"]+)"([^>]*?)>/g,
          (match, before, mid, href, after) => {
            const cleaned = href.replace(/^\.?\/?/, '');
            const integrity = integrityByFile.get(cleaned);
            if (!integrity) return match;
            if (/integrity=/.test(match)) return match;
            const cleanBefore = stripCrossorigin(before || '');
            const cleanMid = stripCrossorigin(mid || '');
            const cleanAfter = stripCrossorigin(after || '');
            return `<link${cleanBefore} rel="stylesheet"${cleanMid} href="/${cleaned}" integrity="${integrity}" crossorigin="anonymous"${cleanAfter}>`;
          }
        );
        return out;
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), sriPlugin()],
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
      },
      '/uploads': {
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
