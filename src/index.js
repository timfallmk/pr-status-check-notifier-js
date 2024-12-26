const { Octokit } = require('@octokit/rest');

// Get configuration from environment variables with defaults
const config = {
  token: process.env.GITHUB_TOKEN,
  excludedChecks: (process.env.EXCLUDED_CHECKS || '').split(',').filter(Boolean),
  pollInterval: parseInt(process.env.POLL_INTERVAL || '30', 10) * 1000, // Convert to milliseconds
  timeoutMinutes: parseInt(process.env.TIMEOUT_MINUTES || '30', 10),
  notificationMessage: process.env.NOTIFICATION_MESSAGE
};

// GitHub context is available in Actions environment
const context = {
  owner: process.env.GITHUB_REPOSITORY.split('/')[0],
  repo: process.env.GITHUB_REPOSITORY.split('/')[1],
  sha: process.env.GITHUB_SHA,
  eventName: process.env.GITHUB_EVENT_NAME,
  prNumber: process.env.GITHUB_EVENT_NAME === 'pull_request'
    ? process.env.GITHUB_EVENT_NUMBER
    : null
};

async function checkStatus(octokit) {
  // Get both status checks and check runs
  const [statusData, checksData] = await Promise.all([
    octokit.repos.getCombinedStatusForRef({
      owner: context.owner,
      repo: context.repo,
      ref: context.sha
    }),
    octokit.checks.listForRef({
      owner: context.owner,
      repo: context.repo,
      ref: context.sha
    })
  ]);

  // Combine and filter checks
  const relevantChecks = [
    ...statusData.data.statuses,
    ...checksData.data.check_runs
  ].filter(check => {
    const checkName = check.name || check.context;
    return !config.excludedChecks.some(excluded =>
      checkName?.toLowerCase().includes(excluded.toLowerCase())
    );
  });

  const successfulConclusions = ['success', 'skipped', 'neutral'];
  let pendingChecks = [];
  let failedChecks = [];
  let passedChecks = [];

  relevantChecks.forEach(check => {
    const isCheckRun = 'conclusion' in check;
    const name = check.name || check.context;
    const status = isCheckRun ? check.status : 'completed';
    const conclusion = isCheckRun ? check.conclusion : check.state;

    const isPassed = status === 'completed' && successfulConclusions.includes(conclusion);
    const isPending = status !== 'completed' || conclusion === null;

    if (isPending) {
      pendingChecks.push(name);
    } else if (isPassed) {
      passedChecks.push(name);
    } else {
      failedChecks.push(name);
    }

    console.log(`Check "${name}": ${status}/${conclusion} (${isPassed ? '✅' : isPending ? '⏳' : '❌'})`);
  });

  return {
    allCompleted: pendingChecks.length === 0,
    allPassed: pendingChecks.length === 0 && failedChecks.length === 0 && passedChecks.length > 0,
    pending: pendingChecks,
    failed: failedChecks,
    passed: passedChecks,
    total: relevantChecks.length
  };
}

async function poll() {
  const octokit = new Octokit({
    auth: config.token
  });

  const startTime = Date.now();
  const timeoutMs = config.timeoutMinutes * 60 * 1000;

  while (true) {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > timeoutMs) {
      console.log('\n::error::⌛ Timed out waiting for checks');
      process.exit(1);
    }

    console.log(`\n::notice::Checking status (${Math.floor(elapsedMs / 1000)}s elapsed)...`);

    try {
      const status = await checkStatus(octokit);

      if (status.allCompleted) {
        if (status.allPassed) {
          console.log('\n::notice::✅ All checks passed! Creating notification...');

          // Get PR details for notification
          const { data: pr } = await octokit.pulls.get({
            owner: context.owner,
            repo: context.repo,
            pull_number: context.prNumber
          });

          // Create success notification
          const message = config.notificationMessage.replace('{user}', pr.user.login);
          await octokit.issues.createComment({
            owner: context.owner,
            repo: context.repo,
            issue_number: context.prNumber,
            body: message
          });

          process.exit(0);
        } else {
          console.log('\n::error::❌ Some checks failed:');
          status.failed.forEach(check => {
            console.log(`  - ${check}`);
          });
          process.exit(1);
        }
      } else {
        console.log('\n::notice::⏳ Waiting for checks to complete:');
        status.pending.forEach(check => {
          console.log(`  - ${check}`);
        });
      }
    } catch (error) {
      console.log('\n::error::Error checking status:', error);
      process.exit(1);
    }

    await new Promise(resolve => setTimeout(resolve, config.pollInterval));
  }
}

// Validate required configuration
if (!config.token) {
  console.log('\n::error::Missing GITHUB_TOKEN');
  process.exit(1);
}

poll().catch(error => {
  console.log('\n::error::Unhandled error:', error);
  process.exit(1);
});