import { describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { evaluatePolicy, compareAllCommits, run, CONTEXTS } = require('../../../.github/scripts/pr-merge-policy.cjs');
const { checkCommit } = require('../../../.github/scripts/check-local-pr.cjs');
const { load } = require('js-yaml');
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const approved = { id: 1, user: { login: 'akhil-glb' }, state: 'APPROVED', commit_id: HEAD };
const fixture = () => ({
  pr: { number: 42, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: HEAD }, user: { login: 'contributor' } },
  mainSha: MAIN,
  comparison: { status: 'ahead', merge_base_commit: { sha: MAIN }, total_commits: 1 },
  commits: [{ sha: HEAD, parents: [{ sha: MAIN }] }],
  verification: { verified: true, reason: 'valid', signature: '-----BEGIN PGP SIGNATURE-----\nsigned' },
  reviews: [approved],
});

describe('PR merge policy', () => {
  test('allows a current, linear, GPG-verified head approved by akhil-glb', () => {
    expect(evaluatePolicy(fixture())).toEqual({ branch: [], approval: [] });
  });
  test.each(['behind', 'diverged', 'identical'])('rejects branches that are not ahead of current main (%s)', (status) => {
    const data = fixture();
    data.comparison.status = status;
    expect(evaluatePolicy(data).branch.join(' ')).toMatch(/Rebase/);
  });
  test('rejects an outdated base even when comparison says ahead', () => {
    const data = fixture();
    data.comparison.merge_base_commit.sha = NEXT;
    expect(evaluatePolicy(data).branch).not.toHaveLength(0);
  });
  test('rejects a merge commit anywhere in the PR range', () => {
    const data = fixture();
    data.commits.unshift({ sha: NEXT, parents: [{ sha: MAIN }, { sha: HEAD }] });
    expect(evaluatePolicy(data).branch.join(' ')).toMatch(/Merge commits/);
  });
  test.each([
    { verified: false, reason: 'unsigned' },
    { verified: true, reason: 'unknown_key', signature: '-----BEGIN PGP SIGNATURE-----' },
    { verified: true, reason: 'valid', signature: '-----BEGIN SSH SIGNATURE-----' },
    { verified: true, reason: 'valid', signature: '-----BEGIN SIGNED MESSAGE-----' },
  ])('rejects unsigned, invalid, SSH, or S/MIME verification (%j)', (verification) => {
    expect(evaluatePolicy({ ...fixture(), verification }).branch.join(' ')).toMatch(/GPG/);
  });
  test('requires approval of the exact latest head, not an old commit', () => {
    expect(evaluatePolicy({ ...fixture(), reviews: [{ ...approved, commit_id: MAIN }] }).approval).not.toHaveLength(0);
  });
  test('does not accept another reviewer instead of akhil-glb', () => {
    expect(evaluatePolicy({ ...fixture(), reviews: [{ ...approved, user: { login: 'someone-else' } }] }).approval).not.toHaveLength(0);
  });
  test.each(['CHANGES_REQUESTED', 'DISMISSED'])('a later %s revokes approval', (state) => {
    expect(evaluatePolicy({ ...fixture(), reviews: [approved, { ...approved, id: 2, state }] }).approval).not.toHaveLength(0);
  });
  test('comment-only reviews do not revoke approval', () => {
    expect(evaluatePolicy({ ...fixture(), reviews: [approved, { ...approved, id: 2, state: 'COMMENTED' }] }).approval).toEqual([]);
  });
  test('akhil-authored PRs have an explicit review-only exception', () => {
    const data = fixture();
    data.pr.user.login = 'akhil-glb';
    data.reviews = [];
    expect(evaluatePolicy(data).approval).toEqual([]);
    data.verification = { verified: false, reason: 'unsigned' };
    data.comparison.merge_base_commit.sha = NEXT;
    expect(evaluatePolicy(data).branch.join(' ')).toMatch(/GPG/);
    expect(evaluatePolicy(data).branch.join(' ')).toMatch(/Rebase/);
  });
  test('draft PRs are blocked', () => {
    const data = fixture();
    data.pr.draft = true;
    expect(evaluatePolicy(data).branch).not.toHaveLength(0);
  });
});

describe('trusted policy orchestration', () => {
  function api() {
    const data = fixture();
    return {
      data,
      github: {
        paginate: vi.fn().mockResolvedValue(data.reviews),
        rest: {
          pulls: { get: vi.fn().mockImplementation(async () => ({ data: data.pr })), list: vi.fn(), listReviews: vi.fn() },
          git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: MAIN } } }) },
          repos: {
            getCommit: vi.fn().mockResolvedValue({ data: { commit: { verification: data.verification } } }),
            compareCommitsWithBasehead: vi.fn().mockResolvedValue({ data: { ...data.comparison, commits: data.commits } }),
            createCommitStatus: vi.fn().mockResolvedValue({}),
          },
        },
      },
      context: { repo: { owner: 'org', repo: 'crm' }, payload: { pull_request: data.pr }, runId: 1, serverUrl: 'https://github.com' },
      core: { warning: vi.fn(), setFailed: vi.fn() },
    };
  }
  test('publishes both statuses against the actual PR head', async () => {
    const setup = api();
    await run(setup);
    for (const context of Object.values(CONTEXTS)) {
      expect(setup.github.rest.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD, state: 'success', context }));
    }
    expect(setup.core.setFailed).not.toHaveBeenCalled();
  });
  test('paginates the entire comparison rather than ignoring commits after 250', async () => {
    const setup = api();
    const rows = Array.from({ length: 301 }, () => ({ parents: [{ sha: MAIN }] }));
    rows[300] = { parents: [{ sha: MAIN }, { sha: NEXT }] };
    setup.github.rest.repos.compareCommitsWithBasehead.mockImplementation(async ({ page, per_page }) => ({
      data: { ...setup.data.comparison, total_commits: rows.length, commits: rows.slice((page - 1) * per_page, page * per_page) },
    }));
    const compared = await compareAllCommits(setup.github, setup.context.repo, MAIN, HEAD);
    expect(compared.commits).toHaveLength(301);
    expect(evaluatePolicy({ ...fixture(), ...compared }).branch.join(' ')).toMatch(/Merge commits/);
  });
  test('incomplete pagination fails closed', async () => {
    const setup = api();
    setup.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { ...setup.data.comparison, total_commits: 1, commits: [] } });
    await expect(compareAllCommits(setup.github, setup.context.repo, MAIN, HEAD)).rejects.toThrow(/Incomplete/);
  });
  test.each(['main', 'head'])('a concurrent %s change cannot publish success', async (changed) => {
    const setup = api();
    if (changed === 'main') {
      setup.github.rest.git.getRef.mockResolvedValueOnce({ data: { object: { sha: MAIN } } })
        .mockResolvedValueOnce({ data: { object: { sha: NEXT } } });
    } else {
      setup.github.rest.pulls.get.mockResolvedValueOnce({ data: setup.data.pr })
        .mockResolvedValueOnce({ data: { ...setup.data.pr, head: { sha: NEXT } } });
    }
    await run(setup);
    expect(setup.core.setFailed).toHaveBeenCalled();
    expect(setup.github.rest.repos.createCommitStatus.mock.calls.some(([call]) => call.state === 'success')).toBe(false);
  });
  test('API errors fail closed, rather than retaining success', async () => {
    const setup = api();
    setup.github.rest.repos.getCommit.mockRejectedValue(new Error('Unavailable'));
    await run(setup);
    expect(setup.core.setFailed).toHaveBeenCalled();
    expect(setup.github.rest.repos.createCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
  });
});

describe('local PR hooks', () => {
  const fakeGit = () => vi.fn((args) => {
    if (args[0] === 'rev-parse') return args[2].includes('pr-policy') ? MAIN : HEAD;
    if (args[0] === 'cat-file') return 'tree test\ngpgsig -----BEGIN PGP SIGNATURE-----\n signature\n\nmessage';
    return '';
  });
  test('fetches current main and verifies the pushed GPG commit', () => {
    const git = fakeGit();
    checkCommit({ signed: true, git });
    expect(git).toHaveBeenCalledWith(['fetch', '--quiet', '--', 'origin', '+refs/heads/main:refs/remotes/pr-policy/main']);
    expect(git).toHaveBeenCalledWith(['verify-commit', HEAD]);
  });
  test('stale branches are rejected before signature checks', () => {
    const git = fakeGit();
    git.mockImplementation((args) => {
      if (args[0] === 'merge-base') throw new Error('not ancestor');
      return MAIN;
    });
    expect(() => checkCommit({ git })).toThrow(/Rebase/);
  });
  test('signature-looking commit messages cannot masquerade as signed headers', () => {
    const git = fakeGit();
    git.mockImplementation((args) => args[0] === 'cat-file'
      ? 'tree test\n\ngpgsig -----BEGIN PGP SIGNATURE-----' : (args[0] === 'rev-parse' ? HEAD : ''));
    expect(() => checkCommit({ signed: true, git })).toThrow(/Sign the latest/);
  });
});

describe('PR workflow wiring', () => {
  const read = (path) => load(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
  test('PRs run canonical six-gate validation with no path skips or secrets', () => {
    const pr = read('.github/workflows/pr-checks.yml');
    expect(pr.on.pull_request.branches).toContain('main');
    expect(pr.on.pull_request['paths-ignore']).toBeUndefined();
    expect(pr.jobs['full-validation'].uses).toBe('./.github/workflows/deploy.yml');
    expect(pr.jobs['full-validation'].with.validation_only).toBe(true);
    expect(pr.jobs['full-validation'].secrets).toBeUndefined();
    const deploy = read('.github/workflows/deploy.yml');
    for (const name of ['build', 'api_tests', 'lint', 'unit_tests', 'frontend_unit_tests', 'migration_check']) {
      expect(deploy.jobs[name]).toBeDefined();
    }
    expect(deploy.jobs.deploy.if).toContain('inputs.validation_only != true');
    expect(deploy.jobs.deploy.if).toContain("github.event_name == 'push'");
    expect(deploy.on.workflow_call.inputs.validation_only.default).toBe(true);
    expect(deploy.jobs.migration_check.steps.find((step) => step.env?.BASELINE_REF).env.BASELINE_REF).toContain('github.event.pull_request.base.sha');
    expect(pr.jobs['required-check'].if).toContain('always()');
    expect(pr.jobs['required-check'].steps[0].run).toContain('!= "success"');
  });
  test('main pushes skip duplicate tests but retain static gates and deployment dependencies', () => {
    const workflow = read('.github/workflows/deploy.yml');
    for (const name of ['api_tests', 'unit_tests', 'frontend_unit_tests']) {
      expect(workflow.jobs[name].if).toBe("${{ inputs.skip_tests != true && github.event_name != 'push' }}");
      expect(workflow.jobs.deploy.needs).toContain(name);
      expect(workflow.jobs.deploy.if).toContain(`needs.${name}.result == 'skipped'`);
    }
    for (const name of ['build', 'lint', 'migration_check']) {
      expect(workflow.jobs[name].if).toBe('${{ inputs.skip_tests != true }}');
      expect(workflow.jobs.deploy.needs).toContain(name);
    }
    expect(workflow.on.push.branches).toEqual(['main']);
  });
  test('privileged policy only checks out trusted main; reviews merely wake it', () => {
    const workflow = read('.github/workflows/pr-merge-policy.yml');
    expect(workflow.on.pull_request_target.branches).toEqual(['main']);
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.schedule[0].cron).toBe('*/5 * * * *');
    expect(workflow.jobs.policy.steps[0].with.ref).toBe('main');
    expect(workflow.jobs.policy.steps[0].with['persist-credentials']).toBe(false);
    expect(workflow.permissions.statuses).toBe('write');
    const notification = read('.github/workflows/pr-review-notification.yml');
    expect(notification.permissions).toEqual({});
    expect(notification.on.pull_request_review.types).toContain('dismissed');
    expect(notification.jobs.notification.steps).toHaveLength(1);
  });
  test('stages the complete main ruleset without an admin or bot bypass', () => {
    const ruleset = read('.github/rulesets/main-merge-policy.json');
    expect(ruleset.enforcement).toBe('disabled');
    expect(ruleset.bypass_actors).toEqual([]);
    expect(ruleset.conditions.ref_name).toEqual({ include: ['refs/heads/main'], exclude: [] });
    const prRule = ruleset.rules.find((rule) => rule.type === 'pull_request').parameters;
    expect(prRule.required_approving_review_count).toBe(0);
    expect(prRule.dismiss_stale_reviews_on_push).toBe(true);
    expect(prRule.require_code_owner_review).toBe(false);
    const checks = ruleset.rules.find((rule) => rule.type === 'required_status_checks').parameters;
    expect(checks.strict_required_status_checks_policy).toBe(true);
    expect(checks.required_status_checks).toEqual([
      { context: 'PR validation', integration_id: 15368 },
      { context: CONTEXTS.branch, integration_id: 15368 },
      { context: CONTEXTS.approval, integration_id: 15368 },
    ]);
    expect(ruleset.rules.some((rule) => rule.type === 'deletion')).toBe(true);
    expect(ruleset.rules.some((rule) => rule.type === 'non_fast_forward')).toBe(true);
  });
});
