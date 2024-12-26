/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 595:
/***/ ((module) => {

module.exports = eval("require")("@octokit/rest");


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
const { Octokit } = __nccwpck_require__(595);

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

    // A check is pending if:
    // - It's in progress
    // - It's queued
    // - It's not completed
    // - It has no conclusion yet
    const isPending = status === 'in_progress' ||
      status === 'queued' ||
      status !== 'completed' ||
      conclusion === null;

    // A check is passed if:
    // - It's completed AND
    // - Has a successful conclusion
    const isPassed = !isPending && status === 'completed' && successfulConclusions.includes(conclusion);

    // A check is failed if:
    // - It's not pending AND
    // - It's not passed
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

async function poll() {
  const octokit = new Octokit({
    auth: config.token
  });

  const startTime = Date.now();
  const timeoutMs = config.timeoutMinutes * 60 * 1000;
  let hasNotified = false;

  while (true) {
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs > timeoutMs) {
      console.log('\n::error::⌛ Timed out waiting for checks');
      process.exit(1);
    }

    const elapsedMinutes = Math.floor(elapsedMs / 60000);
    const elapsedSeconds = Math.floor((elapsedMs % 60000) / 1000);
    console.log(`\n::notice::Checking status (${elapsedMinutes}m ${elapsedSeconds}s elapsed)...`);

    try {
      const status = await checkStatus(octokit);

      if (!status.hasChecks) {
        console.log('No checks found yet, waiting...');
      } else if (status.allCompleted) {
        if (status.allPassed && !hasNotified) {
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

          hasNotified = true;
          process.exit(0);
        } else if (status.failed.length > 0) {
          console.log('\n::error::❌ The following checks failed:');
          status.failed.forEach(check => console.log(`  - ${check}`));
          process.exit(1);
        }
      } else {
        console.log('\n::notice::⏳ Waiting for the following checks:');
        status.pending.forEach(check => console.log(`  - ${check}`));
      }
    } catch (error) {
      console.log('\n::warning::Error checking status (will retry):', error);
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
module.exports = __webpack_exports__;
/******/ })()
;