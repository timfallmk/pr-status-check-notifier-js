const { Octokit } = require('@octokit/rest');
const core = require('@actions/core');
const github = require('@actions/github');
const notificationStore = require('./notificationStore');

// Track notifications at file scope
const sentNotifications = new Set();

function createNotificationId(prNumber) {
  return `pr-${prNumber}`;
}

async function hasExistingComment(octokit, context, prNumber, message) {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      ...context.repo,
      issue_number: prNumber,
      per_page: 100
    });

    const normalizedMessage = message.toLowerCase().trim();
    return comments.some(comment => 
      comment.body.toLowerCase().trim() === normalizedMessage
    );
  } catch (error) {
    core.warning(`Failed to check existing comments: ${error.message}`);
    return false;
  }
}

async function isPRApproved(octokit, context, prNumber) {
  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      ...context.repo,
      pull_number: prNumber
    });
    
    // Get latest review from each reviewer
    const latestReviews = new Map();
    reviews.forEach(review => {
      latestReviews.set(review.user.id, review.state);
    });
    
    // Check if any latest review is APPROVED
    return Array.from(latestReviews.values()).includes('APPROVED');
  } catch (error) {
    core.warning(`Failed to check PR approval status: ${error.message}`);
    return false;
  }
}

async function isPRMergeable(octokit, context, prNumber) {
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      ...context.repo,
      pull_number: prNumber
    });
    
    core.info(`PR mergeable state: ${pr.mergeable_state}`);
    
    if (pr.mergeable === false || pr.mergeable_state !== 'clean') {
      core.info(`PR is not mergeable (state: ${pr.mergeable_state})`);
      return false;
    }
    
    // Add approval check
    if (!await isPRApproved(octokit, context, prNumber)) {
      core.info('PR is not approved');
      return false;
    }
    
    return true;
  } catch (error) {
    core.warning(`Failed to check PR mergeable status: ${error.message}`);
    return false;
  }
}

async function createComment(octokit, context, prNumber, body) {
  // Check mergeable status first
  if (!await isPRMergeable(octokit, context, prNumber)) {
    core.info('Skipping notification - PR is not mergeable');
    return;
  }

  const notificationId = createNotificationId(prNumber);
  
  // Check if already sent this session
  if (sentNotifications.has(notificationId)) {
    core.info('Skipping duplicate notification (same session)');
    return;
  }

  // Check previous comments
  const processedBody = processNotificationBody(body);
  if (await hasExistingComment(octokit, context, prNumber, processedBody)) {
    core.info('Skipping duplicate notification (found in PR history)');
    return;
  }

  try {
    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: prNumber,
      body: processedBody
    });
    
    sentNotifications.add(notificationId);
  } catch (error) {
    core.error(`Failed to create comment: ${error.message}`);
    throw error;
  }
}

async function checkStatus(octokit, context, excludedChecks = []) {
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
    // Move configuration here
    const token = core.getInput('github-token', { required: true });
    const excludedChecks = core.getInput('excluded-checks').split(',').filter(Boolean);
    const pollInterval = parseInt(core.getInput('poll-interval') || '30', 10) * 1000;
    const timeoutMinutes = parseInt(core.getInput('timeout') || '30', 10);

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
      // Add a check for clean shutdown
      if (process.env.NODE_ENV === 'test') {
        break;
      }

      const elapsedMs = Date.now() - startTime;
      if (elapsedMs > timeoutMs) {
        core.info(`Timed out after ${timeoutMinutes} minutes`);
        return;
      }

      const elapsedMinutes = Math.floor(elapsedMs / 60000);
      const elapsedSeconds = Math.floor((elapsedMs % 60000) / 1000);
      core.info(`Checking status (${elapsedMinutes}m ${elapsedSeconds}s elapsed)...`);

      try {
        const status = await checkStatus(octokit, context, excludedChecks);

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
            // Log failed checks but continue waiting
            core.warning('The following checks failed:');
            status.failed.forEach(check => core.warning(`  - ${check}`));
            core.info('Continuing to monitor for changes...');
          }
        } else {
          core.info('Waiting for the following checks:');
          status.pending.forEach(check => core.info(`  - ${check}`));
        }
      } catch (error) {
        core.warning(`Error checking status (will retry): ${error.message}`);
      }

      // Use promisified setTimeout
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

// Only run if not in test environment
if (process.env.NODE_ENV !== 'test') {
  run();
}

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

module.exports = {
  checkStatus,
  createComment,
  hasExistingComment,
  isPRMergeable,
  processNotificationBody,
  run // Export for testing
};