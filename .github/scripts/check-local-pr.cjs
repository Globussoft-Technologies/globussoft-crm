const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

function checkCommit({ sha = 'HEAD', signed = false, remote = 'origin', git = defaultGit }) {
  // Fetch a dedicated ref, rather than trusting a potentially stale local main.
  const baseRef = 'refs/remotes/pr-policy/main';
  git(['fetch', '--quiet', '--', remote, `+refs/heads/main:${baseRef}`]);
  const base = git(['rev-parse', '--verify', baseRef]).trim();
  const head = git(['rev-parse', '--verify', `${sha}^{commit}`]).trim();
  try {
    git(['merge-base', '--is-ancestor', base, head]);
  } catch {
    throw new Error('Rebase this branch onto the latest main before committing or pushing.');
  }
  if (git(['rev-list', '--merges', `${base}..${head}`]).trim()) {
    throw new Error('PR branches must be linear. Rebase instead of merging main into this branch.');
  }
  if (signed) {
    const headers = git(['cat-file', 'commit', head]).split('\n\n')[0];
    if (!/^gpgsig -----BEGIN PGP SIGNATURE-----$/m.test(headers)) {
      throw new Error('Sign the latest commit with GPG: git commit --amend --no-edit -S');
    }
    try {
      git(['verify-commit', head]);
    } catch {
      throw new Error('GPG verification failed. Configure/import the signing public key before pushing.');
    }
  }
}

function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(mode, input = '') {
  const remote = process.env.PR_BASE_REMOTE || 'origin';
  if (mode === 'pre-commit') {
    const branch = defaultGit(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    if (branch === 'main') throw new Error('Create a PR branch; direct commits to main are not allowed.');
    checkCommit({ remote });
  } else if (mode === 'pre-push') {
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const [localRef, sha, remoteRef] = line.split(/\s+/);
      if (remoteRef === 'refs/heads/main') throw new Error('Push a PR branch, not main.');
      if (!localRef.startsWith('refs/heads/') || /^0+$/.test(sha)) continue;
      checkCommit({ sha, signed: true, remote });
    }
  } else {
    throw new Error('Expected pre-commit or pre-push.');
  }
}

if (require.main === module) {
  try {
    main(process.argv[2], process.argv[2] === 'pre-push' ? readFileSync(0, 'utf8') : '');
  } catch (error) {
    console.error(`[PR policy] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkCommit, main };
