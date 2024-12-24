const core = require('@actions/core');
const github = require('@actions/github');

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
    console.log('Event payload:', JSON.stringify(context.payload, null, 2));
    
    if (context.eventName === 'pull_request') {
      sha = context.payload.pull_request.head.sha;
      prNumber = context.payload.pull_request.number;
      console.log('PR event detected:', { sha, prNumber });
    } else if (context.eventName === 'status') {
      sha = context.payload.sha;
      console.log('Status event detected:', { sha });
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
    console.log('Fetching status checks...');
    
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
    
    console.log('\n::notice::Checking status of all checks...');
    const allPassed = relevantChecks.length > 0 && relevantChecks.every(check => {
      const isCheckRun = 'conclusion' in check;
      
      let isPassed;
      if (isCheckRun) {
        isPassed = check.status === 'completed' && successfulConclusions.includes(check.conclusion);
      } else {
        isPassed = successfulConclusions.includes(check.state);
      }
      
      const statusInfo = isCheckRun 
        ? `${check.status}/${check.conclusion}`
        : check.state;
      
      console.log(`Check "${check.name || check.context}": ${statusInfo} (${isPassed ? '✅' : '❌'})`);
      return isPassed;
    });
    
    if (allPassed) {
      console.log('\n::notice::✅ All non-excluded checks have passed!');
      console.log('Checking for existing notifications...');
      
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
    } else {
      console.log('\n::warning::⏳ Some checks are still pending or failed');
    }
  } catch (error) {
    console.log('\n::error::Error in workflow:', error);
    core.setFailed(error.message);
  }
}

run();