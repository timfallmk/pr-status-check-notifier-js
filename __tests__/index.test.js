// __tests__/index.test.js
const core = require('@actions/core');
const github = require('@actions/github');
const { createMockOctokit } = require('./testUtils');

// Mock the required modules
jest.mock('@actions/core');
jest.mock('@actions/github');

describe('PR Status Check Notifier', () => {
    let mockOctokit;

    beforeEach(() => {
        // Clear all mocks before each test
        jest.clearAllMocks();
        // Use modern timers
        jest.useFakeTimers('modern');

        // Mock Octokit instance
        mockOctokit = {
            rest: {
                checks: {
                    listForRef: jest.fn(),
                },
                pulls: {
                    list: jest.fn(),
                    get: jest.fn(),
                    listReviews: jest.fn(),
                },
                issues: {
                    createComment: jest.fn(),
                    listComments: jest.fn(),
                },
                repos: {
                    getCombinedStatusForRef: jest.fn(),
                },
            },
        };

        // Setup GitHub context mock
        github.context = {
            repo: {
                owner: 'test-owner',
                repo: 'test-repo'
            },
            sha: 'test-sha',
            eventName: 'pull_request',
            actor: 'test-user',
            payload: {
                pull_request: {
                    number: 123,
                    head: { sha: 'test-sha' }
                }
            }
        };

        github.getOctokit.mockReturnValue(mockOctokit);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllTimers();
    });

    test('should check PR status correctly', async () => {
        // Mock inputs
        const excludedChecks = ['skip-check'];
        
        // Mock successful checks response
        mockOctokit.rest.checks.listForRef.mockResolvedValue({
            data: {
                check_runs: [{
                    name: 'test-check',
                    status: 'completed',
                    conclusion: 'success'
                }]
            }
        });

        mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
            data: {
                statuses: []
            }
        });

        // Import and test with excludedChecks parameter
        const { checkStatus } = require('../src/index');
        const status = await checkStatus(mockOctokit, github.context, excludedChecks);

        // Verify expectations
        expect(status.hasChecks).toBe(true);
        expect(status.allCompleted).toBe(true);
        expect(status.allPassed).toBe(true);
    });

    // Fix the async polling test
    test('should handle async polling', async () => {
        // Setup environment
        process.env.NODE_ENV = 'test';
        
        // Mock required inputs with proper structure
        core.getInput.mockImplementation((name) => {
            switch(name) {
                case 'github-token': return 'mock-token';
                case 'poll-interval': return '1';
                case 'timeout': return '1';
                case 'excluded-checks': return '';
                default: return '';
            }
        });

        // Mock combined status check
        mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
            data: { statuses: [] }
        });

        // Mock checks API response
        mockOctokit.rest.checks.listForRef.mockResolvedValue({
            data: {
                check_runs: [{
                    name: 'test-check',
                    status: 'completed',
                    conclusion: 'success'
                }]
            }
        });

        await jest.isolateModules(async () => {
            const { run } = require('../src/index');
            
            // Start polling and capture promise
            const runPromise = run();
            
            // Advance timers and wait for promises
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await new Promise(process.nextTick);
            
            // Verify API call
            expect(mockOctokit.rest.checks.listForRef).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                ref: 'test-sha'
            });
            
            // Clean up
            process.env.NODE_ENV = 'test';
            await runPromise;
        });
    });

    test('should handle failed checks', async () => {
        const excludedChecks = ['skip-check'];
        
        // Mock failed check response
        mockOctokit.rest.checks.listForRef.mockResolvedValue({
            data: {
                check_runs: [{
                    name: 'failed-check',
                    status: 'completed',
                    conclusion: 'failure'
                }]
            }
        });

        mockOctokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
            data: {
                statuses: []
            }
        });

        const { checkStatus } = require('../src/index');
        const status = await checkStatus(mockOctokit, github.context, excludedChecks);

        expect(status.hasChecks).toBe(true);
        expect(status.allCompleted).toBe(true);
        expect(status.allPassed).toBe(false);
        expect(status.failed).toContain('failed-check');
    });

    describe('Comment Functionality', () => {
        test('should create new comment when PR is mergeable', async () => {
            // Mock PR as mergeable with approval
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { mergeable: true, mergeable_state: 'clean' }
            });
            
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            // Mock no existing comments
            mockOctokit.rest.issues.listComments.mockResolvedValue({
                data: []
            });
            
            const { createComment } = require('../src/index');
            await createComment(mockOctokit, github.context, 123, 'Test message');
            
            expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                issue_number: 123,
                body: 'Test message'
            });
        });
    
        test('should not create comment when PR is not mergeable', async () => {
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { mergeable: false, mergeable_state: 'dirty' }
            });
            
            const { createComment } = require('../src/index');
            await createComment(mockOctokit, github.context, 123, 'Test message');
            
            expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        });
    });
    
    describe('Existing Comment Check', () => {
        test('should detect existing identical comment', async () => {
            const testMessage = 'Test notification';
            mockOctokit.rest.issues.listComments.mockResolvedValue({
                data: [{ body: testMessage }]
            });
    
            const { hasExistingComment } = require('../src/index');
            const result = await hasExistingComment(mockOctokit, github.context, 123, testMessage);
            
            expect(result).toBe(true);
        });
    
        test('should handle case-insensitive matching', async () => {
            mockOctokit.rest.issues.listComments.mockResolvedValue({
                data: [{ body: 'TEST NOTIFICATION' }]
            });
    
            const { hasExistingComment } = require('../src/index');
            const result = await hasExistingComment(mockOctokit, github.context, 123, 'test notification');
            
            expect(result).toBe(true);
        });
    });
    
    describe('PR Mergeable Status', () => {
        test('should correctly identify mergeable PR', async () => {
            // First mock PR reviews to ensure approval is set
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            // Then mock PR status
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            expect(result).toBe(true);
            expect(mockOctokit.rest.pulls.listReviews).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                pull_number: 123
            });
        });

        test('should handle API errors gracefully', async () => {
            mockOctokit.rest.pulls.get.mockRejectedValue(new Error('API Error'));
    
            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            expect(result).toBe(false);
        });

        test('should block comments when PR is blocked', async () => {
            mockOctokit.rest.pulls.get.mockResolvedValue({
              data: { 
                mergeable: true,
                mergeable_state: 'blocked'
              }
            });
            
            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            expect(result).toBe(false);
        });

        test('should check PR approval status', async () => {
            // Mock PR as mergeable
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            // Mock PR reviews
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            expect(result).toBe(true);
            expect(mockOctokit.rest.pulls.listReviews).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                pull_number: 123
            });
        });

        test('should reject PR without approvals', async () => {
            // Mock PR as mergeable
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            // Mock PR reviews with no approvals
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'COMMENTED'
                }]
            });

            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            expect(result).toBe(false);
        });

        test('should handle multiple reviews from same user', async () => {
            // Mock PR as mergeable
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            // Mock multiple reviews from same user
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [
                    {
                        user: { id: 123 },
                        state: 'APPROVED'
                    },
                    {
                        user: { id: 123 },
                        state: 'CHANGES_REQUESTED'
                    }
                ]
            });

            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            // Should be false because latest review is CHANGES_REQUESTED
            expect(result).toBe(false);
        });

        test('should correctly identify mergeable PR', async () => {
            // Mock PR as mergeable
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { mergeable: true, mergeable_state: 'clean' }
            });

            // Mock approved review
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            expect(result).toBe(true);
        });

        test('should correctly identify mergeable PR', async () => {
            // Mock PR as mergeable
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            // Add PR approval mock
            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            const { isPRMergeable } = require('../src/index');
            const result = await isPRMergeable(mockOctokit, github.context, 123);
            
            expect(result).toBe(true);
            expect(mockOctokit.rest.pulls.listReviews).toHaveBeenCalledWith({
                owner: 'test-owner',
                repo: 'test-repo',
                pull_number: 123
            });
        });
    });
    
    describe('Notification Deduplication', () => {
        beforeEach(() => {
            jest.resetModules();
            const notificationStore = require('../src/notificationStore');
            notificationStore.notifications.clear();

            // Mock PR as mergeable with approval
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            // Mock no existing comments
            mockOctokit.rest.issues.listComments.mockResolvedValue({
                data: []
            });
        });

        test('should not send duplicate notifications', async () => {
            const { createComment } = require('../src/index');
            
            // First notification should go through
            await createComment(mockOctokit, github.context, 123, 'Test message');
            expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
            
            mockOctokit.rest.issues.createComment.mockClear();
            
            // Second identical notification should be blocked
            await createComment(mockOctokit, github.context, 123, 'Test message');
            expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        });

        test('should block different messages to same PR', async () => {
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { mergeable: true, mergeable_state: 'clean' }
            });
            mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });

            const { createComment } = require('../src/index');
            
            // First notification
            await createComment(mockOctokit, github.context, 123, 'First message');
            expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
            
            mockOctokit.rest.issues.createComment.mockClear();
            
            // Different message to same PR should be blocked
            await createComment(mockOctokit, github.context, 123, 'Second message');
            expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        });

        test('should allow same message to different PRs', async () => {
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { mergeable: true, mergeable_state: 'clean' }
            });
            mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });

            const { createComment } = require('../src/index');
            
            // First PR notification
            await createComment(mockOctokit, github.context, 123, 'Test message');
            expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
            
            mockOctokit.rest.issues.createComment.mockClear();
            
            // Same message to different PR should work
            await createComment(mockOctokit, github.context, 456, 'Test message');
            expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
        });
    });

    describe('Notification Deduplication', () => {
        beforeEach(() => {
            jest.resetModules();
            // Clear notification store
            const notificationStore = require('../src/notificationStore');
            notificationStore.notifications.clear();
            
            // Mock PR as mergeable with approval
            mockOctokit.rest.pulls.get.mockResolvedValue({
                data: { 
                    mergeable: true, 
                    mergeable_state: 'clean' 
                }
            });

            mockOctokit.rest.pulls.listReviews.mockResolvedValue({
                data: [{
                    user: { id: 123 },
                    state: 'APPROVED'
                }]
            });

            // Mock no existing comments
            mockOctokit.rest.issues.listComments.mockResolvedValue({
                data: []
            });
        });

        test('should not send duplicate notifications', async () => {
            const { createComment } = require('../src/index');
            
            await createComment(mockOctokit, github.context, 123, 'Test message');
            expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
            
            mockOctokit.rest.issues.createComment.mockClear();
            
            await createComment(mockOctokit, github.context, 123, 'Test message');
            expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
        });
    });
});