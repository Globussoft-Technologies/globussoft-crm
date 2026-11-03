// Trusted, metadata-only policy evaluator. Never check out or execute PR code.
const APPROVER = 'akhil-glb';
const CONTEXTS = { branch: 'PR branch policy', approval: 'PR approval (akhil-glb)' };

function evaluatePolicy({ pr, mainSha, comparison, commits, verification, reviews }) {
  const branch = [];
  const approval = [];
  if (pr.draft) branch.push('Mark the PR ready for review.');
  if (pr.base.ref !== 'main') branch.push('The target must be main.');
  if (comparison.merge_base_commit?.sha !== mainSha || comparison.status !== 'ahead') {
    branch.push('Rebase onto the latest main commit and push the rebased branch.');
  }
  if (commits.some((commit) => commit.parents?.length !== 1)) {
    branch.push('Merge commits are not allowed in the PR; use a linear rebase.');
  }
  if (!verification?.verified || verification.reason !== 'valid'
      || !verification.signature?.startsWith('-----BEGIN PGP SIGNATURE-----')) {
    branch.push('The latest commit must have a GitHub-verified GPG signature (not SSH/S/MIME).');
  }
  if (pr.user?.login?.toLowerCase() === APPROVER) {
    approval.push('GitHub disallows self-approval: a PR authored by akhil-glb cannot satisfy this strict policy.');
  } else {
    // A later comment does not revoke an approval, but a changes-requested or
    // dismissed review does. Approval must belong to the exact current head.
    const decisive = reviews.filter((review) => review.user?.login?.toLowerCase() === APPROVER
      && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
      .sort((a, b) => Number(a.id) - Number(b.id)).at(-1);
    if (decisive?.state !== 'APPROVED' || decisive.commit_id !== pr.head.sha) {
      approval.push('akhil-glb must approve this exact latest commit; older approvals do not count.');
    }
  }
  return { branch, approval };
}

async function compareAllCommits(github, repo, mainSha, headSha) {
  const commits = [];
  let comparison;
  for (let page = 1; ; page += 1) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...repo, basehead: `${mainSha}...${headSha}`, per_page: 100, page,
    });
    comparison ||= data;
    commits.push(...data.commits);
    if (commits.length >= comparison.total_commits) break;
    if (data.commits.length === 0) throw new Error('Incomplete commit comparison; refusing to approve the branch.');
  }
  return { comparison, commits };
}

async function run({ github, context, core }) {
  const repo = context.repo;
  const candidates = context.payload.pull_request
    ? [context.payload.pull_request]
    : await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: 'main', per_page: 100 });
  let failed = false;
  for (const candidate of candidates) {
    // Read current API state, not approval/event payloads which may be stale.
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: candidate.number });
    if (pr.state !== 'open' || pr.base.ref !== 'main') continue;
    const sha = pr.head.sha;
    const status = (category, state, description) => github.rest.repos.createCommitStatus({
      ...repo, sha, context: CONTEXTS[category], state,
      description: description.slice(0, 140),
      target_url: `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
    });
    try {
      await Promise.all(Object.keys(CONTEXTS).map((key) => status(key, 'pending', 'Checking current main, signature, and approval.')));
      const { data: main } = await github.rest.git.getRef({ ...repo, ref: 'heads/main' });
      const mainSha = main.object.sha;
      const [{ comparison, commits }, { data: head }, reviews] = await Promise.all([
        compareAllCommits(github, repo, mainSha, sha),
        github.rest.repos.getCommit({ ...repo, ref: sha }),
        github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: pr.number, per_page: 100 }),
      ]);
      const result = evaluatePolicy({ pr, mainSha, comparison, commits, verification: head.commit.verification, reviews });
      const [{ data: current }, { data: currentMain }] = await Promise.all([
        github.rest.pulls.get({ ...repo, pull_number: pr.number }),
        github.rest.git.getRef({ ...repo, ref: 'heads/main' }),
      ]);
      if (current.head.sha !== sha || currentMain.object.sha !== mainSha) {
        throw new Error('The PR or main changed while checking. Re-run the policy check.');
      }
      for (const [category, errors] of Object.entries(result)) {
        await status(category, errors.length ? 'failure' : 'success', errors[0] || 'Policy satisfied for the current PR head.');
        errors.forEach((error) => core.warning(`PR #${pr.number}: ${error}`));
        failed ||= errors.length > 0;
      }
    } catch (error) {
      failed = true;
      core.warning(`PR #${pr.number}: ${error.message}`);
      await Promise.all(Object.keys(CONTEXTS).map((key) => status(key, 'error', 'Policy could not be verified. Re-run; errors never grant approval.')));
    }
  }
  if (failed) core.setFailed('One or more PRs do not meet the merge policy. See their commit statuses.');
}

module.exports = { APPROVER, CONTEXTS, evaluatePolicy, compareAllCommits, run };
