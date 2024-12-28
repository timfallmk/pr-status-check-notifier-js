// __tests__/setup.js

// Increase Jest timeout
jest.setTimeout(10000);

// Add custom matchers if needed
expect.extend({
    toBeValidStatus(received) {
        return {
            pass: received.hasChecks !== undefined &&
                  received.allCompleted !== undefined &&
                  received.allPassed !== undefined,
            message: () => 'Expected response to be a valid status object'
        };
    }
});