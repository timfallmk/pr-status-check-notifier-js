const { Octokit } = require('@octokit/rest');
const core = require('@actions/core');
const github = require('@actions/github');

// Add at the top with other constants
const sentNotifications = new Set();

// Add helper function
function createNotificationId(check) {
  return `${check.name}-${check.status}-${check.conclusion || ''}-${check.started_at || ''}-${check.completed_at || ''}`;
}

function isNotificationDuplicate(check) {
  const notificationId = createNotificationId(check);
  if (sentNotifications.has(notificationId)) {
    core.debug(`Skipping duplicate notification for ${check.name}`);
    return true;
  }
  sentNotifications.add(notificationId);
  return false;
}

// Get inputs with core helpers
const token = core.getInput('github-token', { required: true });
const excludedChecks = core.getInput('excluded-checks').split(',').filter(Boolean);
const pollInterval = parseInt(core.getInput('poll-interval') || '30', 10) * 1000;
const timeoutMinutes = parseInt(core.getInput('timeout') || '30', 10);

async function checkStatus(octokit, context) {
  let sha = context.sha;
  
  // If this is a PR event, use the PR head SHA
  if (context.payload.pull_request) {
    sha = context.payload.pull_request.head.sha;
  }
  
  core.info('--------------------');
  core.info(`Checking status for ${context.repo.owner}/${context.repo.repo}@${sha}`);
  
  try {
    // Fetch status checks
    const statusData = await octokit.rest.repos.getCombinedStatusForRef({
      ...context.repo,
      ref: sha
    });

    // Fetch check runs
    const checksData = await octokit.rest.checks.listForRef({
      ...context.repo,
      ref: sha
    });

    // Log summary counts
    core.info(`Found ${statusData.data.statuses.length} status check(s) and ${checksData.data.check_runs.length} check run(s)`);
    
    if (excludedChecks.length > 0) {
      core.info(`Excluding: ${excludedChecks.join(', ')}`);
    }

    // Log active checks
    if (statusData.data.statuses.length > 0) {
      core.info('Status Checks:');
      statusData.data.statuses.forEach(status => {
        core.info(`  • ${status.context}: ${status.state}`);
      });
    }

    if (checksData.data.check_runs.length > 0) {
      core.info('Check Runs:');
      checksData.data.check_runs.forEach(check => {
        core.info(`  • ${check.name}: ${check.status}/${check.conclusion}`);
      });
    }

    // Combine and filter checks
    const relevantChecks = [
      ...statusData.data.statuses,
      ...checksData.data.check_runs
    ].filter(check => {
      const checkName = check.name || check.context;
      const isExcluded = excludedChecks.some(excluded =>
        checkName?.toLowerCase().includes(excluded.toLowerCase())
      );
      if (isExcluded) {
        core.info(`Excluding check: ${checkName}`);
      }
      return !isExcluded;
    });

    core.info(`Found ${relevantChecks.length} relevant checks after filtering`);

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
  } catch (error) {
    core.warning(`Error fetching status or checks: ${error.message}`);
    throw error;
  }
}

async function run() {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;

    core.info('Context info:');
    core.info(`Event name: ${context.eventName}`);
    core.info(`SHA: ${context.sha}`);
    core.info(`Ref: ${context.ref}`);
    core.info(`Repo: ${context.repo.owner}/${context.repo.repo}`);

    let prNumber;

    if (context.eventName === 'pull_request') {
      prNumber = context.payload.pull_request.number;
      core.info(`Found PR number from pull_request event: ${prNumber}`);
    } else {
      // Log all open PRs to debug
      const { data: allPrs } = await octokit.rest.pulls.list({
        ...context.repo,
        state: 'open'
      });

      core.info(`Found ${allPrs.length} open PRs:`);
      allPrs.forEach(pr => {
        core.info(`PR #${pr.number}: ${pr.head.sha} (${pr.title})`);
      });

      // Try to find PR from current SHA
      const matchingPr = allPrs.find(pr => pr.head.sha === context.sha);

      if (!matchingPr) {
        core.setFailed(`No matching PR found for SHA: ${context.sha}`);
        return;
      }
      prNumber = matchingPr.number;
      core.info(`Found matching PR #${prNumber}`);

      // Get all checks for this PR
      const { data: checks } = await octokit.rest.checks.listForRef({
        ...context.repo,
        ref: matchingPr.head.sha
      });

      core.info('Available check runs:');
      checks.check_runs.forEach(check => {
        core.info(`- ${check.name}: ${check.status}/${check.conclusion}`);
      });
    }

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
            await createComment(octokit, context, prNumber, message);

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

function processNotificationBody(body) {
  return body
    // Convert escaped newlines to actual newlines
    .replace(/\\n/g, '\n')
    // Convert escaped tabs to actual tabs  
    .replace(/\\t/g, '\t')
    // Convert Unicode escape sequences
    .replace(/\\u[\dA-F]{4}/gi, match => 
      String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16))
    )
    // Unescape other characters
    .replace(/\\(.)/g, '$1');
}

async function createComment(octokit, context, prNumber, body) {
  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: prNumber,
    body: processNotificationBody(body)
  });
}