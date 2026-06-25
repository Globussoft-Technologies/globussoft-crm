/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript — let Next compile them.
  transpilePackages: [
    '@agentic-os/shared',
    '@agentic-os/providers',
    '@agentic-os/tools',
    '@agentic-os/sectors',
    '@agentic-os/core',
  ],
  // puppeteer is a heavy node-only dependency (bundles Chromium); never bundle it.
  serverExternalPackages: ['puppeteer'],
  webpack: (config) => {
    // The packages import with explicit ".js" specifiers that point at ".ts"
    // sources (NodeNext style). Map them so webpack resolves the TS files.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  // Fundamental HTTP security headers applied to every response.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // SAMEORIGIN (not DENY) so the dashboard can frame its own /generated
          // deliverable PDFs; still blocks framing by any other origin.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next dev needs inline/eval; tighten (drop 'unsafe-*') for production builds.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              // https: lets the generated HTML fallback show Pollinations/LoremFlickr
              // imagery; the primary PDF is rendered server-side and doesn't need it.
              "img-src 'self' data: https:",
              "connect-src 'self'",
              // 'self' (not 'none') so the dashboard can preview its own /generated PDFs.
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
