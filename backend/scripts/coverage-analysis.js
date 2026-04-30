// Local-only analysis script. Reads /tmp/cov-art/coverage/coverage-summary.json
// from the most recent coverage workflow artifact and prints the top under-
// covered files sorted by absolute uncovered-line count. Excludes PRD-skipped
// files (Callified territory) and tiny files (< 30 statements). Not part of
// the build / not gitignored — backend/scripts/ is in c8 exclude list and
// gitignored generally? Let me just leave the file under scripts/ since
// scripts/ is excluded from CI but tracked in git typically.

const path = require('path');
const fs = require('fs');
const argPath = process.argv[2] || path.join(__dirname, '..', 'coverage-snapshot', 'coverage', 'coverage-summary.json');
const sumPath = path.isAbsolute(argPath) ? argPath : path.resolve(process.cwd(), argPath);
const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));

const PRD_SKIP = ['routes/voice.js', 'routes/voice_transcription.js', 'routes/whatsapp.js'];

function relPath(file) {
  return file.split(/[\/\\]backend[\/\\]/).pop().replace(/\\/g, '/');
}

const rows = Object.entries(sum)
  .filter(([k]) => k !== 'total')
  .map(([file, v]) => {
    const rel = relPath(file);
    const total = v.lines.total;
    const covered = v.lines.covered;
    const uncov = total - covered;
    return {
      file: rel,
      lines: v.lines.pct,
      total,
      covered,
      uncov,
      funcs: v.functions.pct,
      fns_total: v.functions.total,
    };
  })
  .filter((r) => !PRD_SKIP.some((p) => r.file.endsWith(p)))
  .filter((r) => r.total >= 30)
  .sort((a, b) => b.uncov - a.uncov)
  .slice(0, 30);

console.log('rank | uncov | total | lines% | funcs% | file');
console.log('-----+-------+-------+--------+--------+------');
rows.forEach((r, i) => {
  console.log(
    String(i + 1).padStart(4) +
      ' | ' +
      String(r.uncov).padStart(5) +
      ' | ' +
      String(r.total).padStart(5) +
      ' | ' +
      r.lines.toFixed(1).padStart(6) +
      ' | ' +
      r.funcs.toFixed(1).padStart(6) +
      ' | ' +
      r.file,
  );
});

const top = rows.reduce((s, r) => s + r.uncov, 0);
const all = Object.entries(sum)
  .filter(([k]) => k !== 'total')
  .reduce((s, [, v]) => s + (v.lines.total - v.lines.covered), 0);
console.log('');
console.log(`Top-${rows.length} uncovered: ${top}`);
console.log(`All uncovered:    ${all}`);
console.log(`Top-${rows.length} / all:  ${((100 * top) / all).toFixed(1)}%`);
