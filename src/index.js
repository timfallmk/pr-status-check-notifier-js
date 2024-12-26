const core = require('@actions/core');
const github = require('@actions/github');

const STATUS_COMMENT_MARKER = '<!-- PR-STATUS-CHECK -->';

async function getCurrentStatus(octokit, context, sha, excludedChecks) {
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

  const allCompleted = pendingChecks.length === 0;
  const allPassed = allCompleted && failedChecks.length === 0 && passedChecks.length > 0;

  return {
    allCompleted,
    allPassed,
    pendingChecks,
    failedChecks,
    passedChecks,
    total: relevantChecks.length
  };
}

async function updateStatusComment(octokit, context, pr, status) {
  const statusEmoji = status.allPassed ? '✅' : status.failedChecks.length > 0 ? '❌' : '⏳';
  let statusMessage = `${STATUS_COMMENT_MARKER}\n### PR Status Check ${statusEmoji}\n\n`;

  if (status.passedChecks.length > 0) {
    statusMessage += `**Passed Checks:**\n${status.passedChecks.map(c => `- ${c} ✅`).join('\n')}\n\n`;
  }

  if (status.pendingChecks.length > 0) {
    statusMessage += `**Pending Checks:**\n${status.pendingChecks.map(c => `- ${c} ⏳`).join('\n')}\n\n`;
  }

  if (status.failedChecks.length > 0) {
    statusMessage += `**Failed Checks:**\n${status.failedChecks.map(c => `- ${c} ❌`).join('\n')}\n\n`;
  }

  statusMessage += `Last updated: ${new Date().toISOString()}`;

  // Find existing status comment
  const comments = await octokit.rest.issues.listComments({
    ...context.repo,
    issue_number: pr.number
  });

  const existingComment = comments.data.find(comment =>
    comment.body.includes(STATUS_COMMENT_MARKER)
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      ...context.repo,
      comment_id: existingComment.id,
      body: statusMessage
    });
  } else {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pr.number,
      body: statusMessage
    });
  }

  return status.allPassed;
}

async function notifySuccess(octokit, context, pr, notificationTemplate) {
  const comments = await octokit.rest.issues.listComments({
    ...context.repo,
    issue_number: pr.number
  });

  const hasNotification = comments.data.some(comment =>
    comment.body.includes('All checks have passed!') && !comment.body.includes(STATUS_COMMENT_MARKER)
  );

  if (!hasNotification) {
    console.log('Creating success notification comment...');
    const message = notificationTemplate.replace('{user}', pr.user.login);
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: pr.number,
      body: message
    });
    console.log('Success notification created');
  }
}

async function run() {
  try {
    console.log('\n::notice::Starting PR status check...');

    // Get inputs
    const token = core.getInput('github-token', { required: true });
    const excludedChecks = core.getInput('excluded-checks').split(',').map(s => s.trim());
    const notificationTemplate = core.getInput('notification-message');

    const octokit = github.getOctokit(token);
    const context = github.context;

    // Get event context
    let sha, prNumber;

    console.log('Event type:', context.eventName);

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
        eventName: context.eventName
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

    // Get current status
    const status = await getCurrentStatus(octokit, context, sha, excludedChecks);

    // Update status comment
    const isComplete = await updateStatusComment(octokit, context, pr, status);

    // If everything passed, create success notification
    if (isComplete) {
      await notifySuccess(octokit, context, pr, notificationTemplate);
    }

  } catch (error) {
    console.log('\n::error::Error in workflow:', error);
    core.setFailed(error.message);
  }
}

run();