#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
existing=$(git config --get core.hooksPath || true)
if [ -n "$existing" ] && [ "$existing" != '.githooks' ]; then
  echo "Existing hooksPath is $existing; integrate these hooks manually instead of replacing it." >&2
  exit 1
fi
chmod +x .githooks/pre-commit .githooks/pre-push
git config --local core.hooksPath .githooks
git config --local commit.gpgSign true
git config --local gpg.format openpgp
echo 'PR hooks installed for this clone. Configure user.signingkey and upload the public GPG key to GitHub.'
