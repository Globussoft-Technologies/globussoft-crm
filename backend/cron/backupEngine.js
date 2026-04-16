const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function initBackupCron() {
  // Run daily at 2 AM
  cron.schedule('0 2 * * *', () => {
    runBackup();
  });
  console.log('[Backup] Cron scheduled: daily at 02:00');
}

function runBackup() {
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { console.warn('[Backup] DATABASE_URL not set, skipping'); return; }

    // Parse DATABASE_URL: mysql://user:pass@host:port/dbname
    const match = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);
    if (!match) { console.warn('[Backup] Could not parse DATABASE_URL'); return; }
    const [, user, pass, host, port, dbName] = match;

    const backupDir = path.resolve(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `backup-${timestamp}.sql.gz`;
    const filepath = path.join(backupDir, filename);

    console.log(`[Backup] Starting backup to ${filename}...`);
    execSync(
      `mysqldump -h "${host}" -P ${port} -u "${user}" -p"${pass}" --single-transaction --quick "${dbName}" | gzip > "${filepath}"`,
      { stdio: 'pipe', timeout: 300000 } // 5 min timeout
    );

    // Cleanup: keep only last 30 days
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup-') && f.endsWith('.sql.gz'));
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const fpath = path.join(backupDir, f);
      if (fs.statSync(fpath).mtimeMs < cutoff) {
        fs.unlinkSync(fpath);
        console.log(`[Backup] Cleaned old backup: ${f}`);
      }
    }

    const size = fs.statSync(filepath).size;
    console.log(`[Backup] Complete: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error('[Backup] Failed:', err.message);
  }
}

module.exports = { initBackupCron, runBackup };
