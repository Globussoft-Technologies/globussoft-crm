# PR validation and merge policy

## Activation status

The repository changes provide the checks and optional developer hooks. **They
do not enforce merging until a repository admin configures the main branch
rule below.** A workflow failure alone cannot prevent a writer from merging.
The authenticated `akhil-glb` account has Admin access (verified 3 November
2026), so it can activate the ruleset after the workflow bootstrap is merged.
Do not describe this policy as active until the rule is verified in GitHub.

## What runs

Every PR to `main` (including docs, scripts, and workflow changes) runs the same
six canonical gates: build plus bundle budgets, API tests, lint plus audit,
backend units/integration tests, frontend units, and migration safety. API tests
use their own MySQL service; no deployment secrets are inherited. PR validation
calls `deploy.yml` with `validation_only: true`; that path **cannot deploy**.
Migration safety compares against the PR base SHA, not the PR's last commit.
The aggregate **PR validation** check must succeed.

After merge, pushes to `main` rerun build, lint, and migration safety before
deployment. API, backend-unit, and frontend-unit tests are skipped on that push
because they remain mandatory before merge. Manual deployments still run all
six gates unless the explicit emergency `skip_tests` input is selected.

Two metadata-only statuses are published on the actual PR head:

* **PR branch policy**: contains the latest `main`, has no merge commits in its
  PR range (a real linear rebase, not "merge main"), is not a draft, and its
  latest commit has a valid GitHub-verified **OpenPGP/GPG** signature. SSH and
  S/MIME signatures do not satisfy this specific request. Older commits are
  not required to be signed by this policy.
* **PR approval (akhil-glb)**: `akhil-glb` has approved the exact current head,
  or the PR is authored by `akhil-glb` (explicit review-only exception).
  A later request for changes/dismissal or a new commit invalidates approval.
  Comment-only reviews do not revoke an existing approval.

The trusted policy workflow runs from `main` and reads GitHub metadata only;
it never executes PR code, downloads PR artifacts, or installs PR dependencies.
It refreshes on PR updates, pushes to main, review notifications, manual runs,
and a five-minute scheduled fallback. Scheduled runs can be delayed by GitHub.
Base updates immediately block merging through the native strict-up-to-date
rule, even before the scheduled metadata refresh runs.

## Required admin setup (mandatory)

The complete ruleset definition is committed as
`.github/rulesets/main-merge-policy.json`. Its initial enforcement is
`disabled`, with no bypass actors. Keep it disabled until the workflows and
CODEOWNERS file exist on `main`; otherwise the missing required contexts will
block even the PR intended to install them. After that bootstrap merge, change
the ruleset to `active` in Settings > Rules > Rulesets, and verify its effective
rules on `main`. Do not enable native all-commit signatures as a substitute for
the latest-commit OpenPGP check: they enforce different requirements.

Staged repository ruleset:
[`main: verified PRs and akhil approval` (26431129)](https://github.com/Globussoft-Technologies/globussoft-crm/rules/26431129).

After these files land on `main`, run the checks once so their names appear in
Settings. An admin must edit the existing main branch rule (or create one if
none exists), preserving any unrelated existing protection:

1. Require a pull request before merging, with zero native required approvals
   and no native Code Owner approval requirement. The mandatory custom approval
   status enforces author-dependent approval; CODEOWNERS remains review routing.
2. Dismiss stale approvals when new commits are pushed. Do not allow other
   users to dismiss reviews or bypass the rule unless the policy is explicitly
   changed. Do not enable an admin/bot bypass list.
3. Require these three status checks, selecting the GitHub Actions source
   where available (not an arbitrary external status producer):
   `PR validation`, `PR branch policy`, `PR approval (akhil-glb)`.
4. Enable **Require branches to be up to date before merging**.
5. Apply the rule to administrators / enable **Do not allow bypassing the
   above settings**. Disallow force pushes, branch deletion, and direct
   pushes to main. Review overlapping organization rules as well.
6. Verify with a negative PR: unsigned head, stale base, missing approval,
   approval on an older head, and a failing test must each block merging.
   Only a signed, up-to-date PR with all six gates green and a current
   `akhil-glb` approval (or the explicit author exception) should be mergeable.

Native "Require signed commits" is optional stronger protection: GitHub applies
it to all commits, not just the latest commit requested here. The mandatory
`PR branch policy` status checks the narrower latest-GPG-commit requirement.

**Self-authored PRs:** GitHub does not allow self-approval. PRs authored by
`akhil-glb` are explicitly exempt from review only. All required validation,
GPG signature, linear history and latest-main checks still apply. Every other
author still requires current-head approval from `akhil-glb`.

**Activation order:** merge the updated trusted evaluator into main first,
then change the live ruleset review count to zero and Code Owner requirement
to false. Keep all three required statuses and an empty bypass list. Until
both steps are complete the exception is not active. For the bootstrap PR,
another contributor must open it so `akhil-glb` can approve under the old rule.

## Optional local pre-commit / pre-push hooks

Each developer opts in once per clone (Git cannot automatically activate hooks
for everyone through a committed file):

```sh
./scripts/install-pr-hooks.sh
git config --local user.signingkey YOUR_GPG_KEY_ID
```

Upload the matching public GPG key to GitHub and use an email associated with
the account. Never commit, upload, or share a private key. The installer enables
GPG signing locally and refuses to replace an unrelated existing hooks path.

The pre-commit hook fetches current main and rejects stale/non-linear branches
or direct commits on main. The pre-push hook checks each pushed branch tip,
rejects direct main pushes, and verifies the GPG signature. It checks signatures
after the commit exists; a pre-commit hook cannot verify a future commit.
For a fork, set `PR_BASE_REMOTE=upstream` to fetch the canonical main branch.

```sh
git fetch origin main
git rebase origin/main
git commit --amend --no-edit -S
git push --force-with-lease
```

Rebasing changes commit IDs and usually removes old signatures. Sign the final
tip **after** rebasing, then request a new approval of that exact head. Hooks
can be bypassed locally, so server-side required checks and branch protection,
not hooks, are the enforcement boundary. GPG failures never auto-generate keys
or fall back to an unsigned push.

Official references: [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
