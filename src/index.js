const { Octokit } = require('@octokit/rest');
const core = require('@actions/core');
const github = require('@actions/github');

// Get inputs with core helpers
const token = core.getInput('github-token', { required: true });
const excludedChecks = core.getInput('excluded-checks').split(',').filter(Boolean);
const pollInterval = parseInt(core.getInput('poll-interval') || '30', 10) * 1000;
const timeoutMinutes = parseInt(core.getInput('timeout') || '30', 10);

async function checkStatus(octokit, context) {
  const [statusData, checksData] = await Promise.all([
    octokit.rest.repos.getCombinedStatusForRef({
      ...context.repo,
      ref: context.sha
    }),
    octokit.rest.checks.listForRef({
      ...context.repo,
      ref: context.sha
    })
  ]);

  // Combine and filter checks
  const relevantChecks = [
    ...statusData.data.statuses,
    ...checksData.data.check_runs
  ].filter(check => {
    const checkName = check.name || check.context;
    return !excludedChecks.some(excluded =>
      checkName?.toLowerCase().includes(excluded.toLowerCase())
    );
  });

  console.log(`Found ${relevantChecks.length} relevant checks`);

  const successfulConclusions = ['success', 'skipped', 'neutral'];
  const pendingChecks = [];
  const failedChecks = [];
  const passedChecks = [];

  relevantChecks.forEach(check => {
    const isCheckRun = 'conclusion' in check;
    const name = check.name || check.context;
    const status = isCheckRun ? check.status : 'completed';
    const conclusion = isCheckRun ? check.conclusion : check.state;

    const isPending = status === 'in_progress' ||
      status === 'queued' ||
      status !== 'completed' ||
      conclusion === null;
    const isPassed = !isPending && status === 'completed' && successfulConclusions.includes(conclusion);
    const isFailed = !isPending && !isPassed;

    console.log(`Check "${name}":
  Status: ${status}
  Conclusion: ${conclusion}
  State: ${isPending ? '⏳ Pending' : isPassed ? '✅ Passed' : '❌ Failed'}
  Reason: ${isPending ? 'Still running' : isPassed ? 'Completed successfully' : 'Completed with failure'}`);

    if (isPending) pendingChecks.push(name);
    else if (isPassed) passedChecks.push(name);
    else failedChecks.push(name);
  });

  return {
    hasChecks: relevantChecks.length > 0,
    allCompleted: pendingChecks.length === 0,
    allPassed: pendingChecks.length === 0 && failedChecks.length === 0 && passedChecks.length > 0,
    pending: pendingChecks,
    failed: failedChecks,
    passed: passedChecks
  };
}

async function run() {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;

    let prNumber;

    if (context.eventName === 'pull_request') {
      prNumber = context.payload.pull_request.number;
      core.info(`Found PR number from pull_request event: ${prNumber}`);
    } else {
      // Try to find PR from current SHA
      const { data: prs } = await octokit.rest.pulls.list({
        ...context.repo,
        state: 'open',
        head: context.sha
      });

      if (prs.length === 0) {
        core.setFailed('No matching PR found');
        return;
      }
      prNumber = prs[0].number;
      core.info(`Found PR number from SHA lookup: ${prNumber}`);
    }

    const startTime = Date.now();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    let hasNotified = false;

    while (true) {
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > timeoutMs) {
        core.setFailed(`Timed out after ${timeoutMinutes} minutes`);
        return;
      }

      const elapsedMinutes = Math.floor(elapsedMs / 60000);
      const elapsedSeconds = Math.floor((elapsedMs % 60000) / 1000);
      core.info(`Checking status (${elapsedMinutes}m ${elapsedSeconds}s elapsed)...`);

      try {
        const status = await checkStatus(octokit, context);

        if (!status.hasChecks) {
          core.info('No checks found yet, waiting...');
        } else if (status.allCompleted) {
          if (status.allPassed && !hasNotified) {
            core.info('All checks passed! Creating notification...');

            // Create success notification
            const message = core.getInput('notification-message').replace('{user}', context.actor);
            await octokit.rest.issues.createComment({
              ...context.repo,
              issue_number: prNumber,
              body: message
            });

            hasNotified = true;
            return;
          } else if (status.failed.length > 0) {
            core.error('The following checks failed:');
            status.failed.forEach(check => core.error(`  - ${check}`));
            core.setFailed('Some checks failed');
            return;
          }
        } else {
          core.info('Waiting for the following checks:');
          status.pending.forEach(check => core.info(`  - ${check}`));
        }
      } catch (error) {
        core.warning(`Error checking status (will retry): ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();