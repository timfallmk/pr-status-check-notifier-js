module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.js'],
    collectCoverage: true,
    roots: ['<rootDir>/__tests__'],
    moduleDirectories: ['node_modules', 'src'],
    setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
    testTimeout: 10000
};