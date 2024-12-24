const core = require('@actions/core');
const github = require('@actions/github');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkStatus(octokit, context, sha, excludedChecks) {
  // Get both status checks and check runs
  const [statusData, checksData] = await Promise.all([
    octokit.rest.repos.getCombinedStatusForRef({
      ...context.repo,
      ref: sha
    }),
    octokit.rest.checks.listForRef({
      ...context.repo,
      ref: sha
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

  console.log('Non-excluded checks count:', relevantChecks.length);

  const successfulConclusions = ['success', 'skipped', 'neutral'];
  let pendingChecks = [];
  let failedChecks = [];

  const checkResults = relevantChecks.map(check => {
    const isCheckRun = 'conclusion' in check;
    const name = check.name || check.context;
    const status = isCheckRun ? check.status : 'completed';
    const conclusion = isCheckRun ? check.conclusion : check.state;

    const isPassed = status === 'completed' && successfulConclusions.includes(conclusion);
    const isPending = status !== 'completed' || conclusion === null;

    if (isPending) {
      pendingChecks.push(name);
    } else if (!isPassed) {
      failedChecks.push(name);
    }

    console.log(`Check "${name}": ${status}/${conclusion} (${isPassed ? '✅' : isPending ? '⏳' : '❌'})`);
    return { isPassed, isPending, name };
  });

  const allCompleted = !checkResults.some(r => r.isPending);
  const allPassed = checkResults.length > 0 && checkResults.every(r => r.isPassed);

  return {
    allCompleted,
    allPassed,
    pendingChecks,
    failedChecks,
  };
}

async function run() {
  try {
    console.log('\n::notice::Starting PR status check...');

    // Get inputs
    const token = core.getInput('github-token', { required: true });
    const excludedChecks = core.getInput('excluded-checks').split(',').map(s => s.trim());
    const notificationTemplate = core.getInput('notification-message');
    const maxWaitMinutes = parseInt(core.getInput('max-wait-minutes') || '30', 10);
    const pollInterval = parseInt(core.getInput('poll-interval-seconds') || '30', 10);

    const octokit = github.getOctokit(token);
    const context = github.context;

    // Get event context
    let sha, prNumber;

    console.log('Event type:', context.eventName);
    console.log('Event payload:', JSON.stringify(context.payload, null, 2));

    if (context.eventName === 'pull_request') {
      sha = context.payload.pull_request.head.sha;
      prNumber = context.payload.pull_request.number;
      console.log('PR event detected:', { sha, prNumber });
    } else if (context.eventName === 'status') {
      sha = context.payload.sha;
      console.log('Status event detected:', { sha });
    } else if (context.eventName === 'workflow_dispatch') {
      sha = context.sha;
      console.log('Workflow dispatch event detected:', { sha });
    } else {
      console.log('Unsupported event type:', context.eventName);
      console.log('Available context:', {
        sha: context.sha,
        ref: context.ref,
        eventName: context.eventName,
        payload: context.payload
      });
      sha = context.sha;
    }

    if (!sha) {
      throw new Error('Could not determine SHA');
    }

    // Get PR details
    let pr;
    if (prNumber) {
      console.log('Fetching PR by number:', prNumber);
      const { data: prData } = await octokit.rest.pulls.get({
        ...context.repo,
        pull_number: prNumber
      });
      pr = prData;
    } else {
      console.log('Searching for PR by SHA:', sha);
      const { data: prs } = await octokit.rest.pulls.list({
        ...context.repo,
        state: 'open',
        sort: 'updated',
        direction: 'desc'
      });

      pr = prs.find(p => p.head.sha === sha);
      if (!pr) {
        console.log(`No PR found for SHA: ${sha}`);
        return;
      }
    }

    console.log(`\n::notice::Found PR #${pr.number}: ${pr.title}`);
    console.log('Starting check status monitoring...');

    const startTime = Date.now();
    const timeout = maxWaitMinutes * 60 * 1000;
    let lastPendingMessage = '';

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeout) {
        console.log('\n::warning::⌛ Timed out waiting for checks to complete');
        core.setFailed(`Timed out after ${maxWaitMinutes} minutes`);
        return;
      }

      const status = await checkStatus(octokit, context, sha, excludedChecks);

      if (status.allCompleted) {
        if (status.allPassed) {
          console.log('\n::notice::✅ All non-excluded checks have passed!');

          // Check for existing notification
          const comments = await octokit.rest.issues.listComments({
            ...context.repo,
            issue_number: pr.number
          });

          const hasNotification = comments.data.some(comment =>
            comment.body.includes('All checks have passed!')
          );

          if (!hasNotification) {
            console.log('Creating notification comment...');
            const message = notificationTemplate.replace('{user}', pr.user.login);
            await octokit.rest.issues.createComment({
              ...context.repo,
              issue_number: pr.number,
              body: message
            });
            console.log('Notification created successfully');
          }
          return;
        } else {
          console.log('\n::error::❌ Some checks failed:');
          status.failedChecks.forEach(check => {
            console.log(`  - ${check}`);
          });
          core.setFailed('Some checks failed');
          return;
        }
      } else {
        const pendingMessage = `⏳ Waiting for checks to complete (${Math.floor(elapsed / 1000)}s elapsed): ${status.pendingChecks.join(', ')}`;
        if (pendingMessage !== lastPendingMessage) {
          console.log('\n::notice::' + pendingMessage);
          lastPendingMessage = pendingMessage;
        }
        await sleep(pollInterval * 1000);
      }
    }
  } catch (error) {
    console.log('\n::error::Error in workflow:', error);
    core.setFailed(error.message);
  }
}

run();