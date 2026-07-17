// PM2 process-management config for the production/demo backend
// (crm.globusdemos.com). Tracked in git so process identity (name/script/
// cwd) survives a fresh box / a `pm2 delete && pm2 start` recovery, instead
// of living only in PM2's own untracked dump file on the server.
//
// Intentionally NOT setting max_memory_restart / max_restarts / backoff
// here — those need a real threshold sized off actual server RAM + observed
// steady-state RSS, not a guess. Left to PM2's own defaults (no memory
// ceiling, unlimited restarts) until someone pulls real numbers from the box
// and decides deliberately. Track memory over time via the deploy.yml
// "Capture PM2 snapshot" Telegram alerts.
//
// Does NOT set env vars here on purpose — all secrets/config stay in
// backend/.env (loaded via dotenv at server.js startup), so this file has
// no environment-specific values that would need to differ between demo and
// any future environment.
module.exports = {
  apps: [
    {
      name: "globussoft-crm-backend",
      script: "server.js",
      cwd: __dirname,
    },
  ],
};
