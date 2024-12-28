const createMockOctokit = () => ({
  rest: {
    checks: { listForRef: jest.fn() },
    pulls: { list: jest.fn(), get: jest.fn() },
    issues: { createComment: jest.fn(), listComments: jest.fn() },
    repos: { getCombinedStatusForRef: jest.fn() }
  }
});

module.exports = { createMockOctokit };