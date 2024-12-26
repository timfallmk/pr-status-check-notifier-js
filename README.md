# PR Check Status Notifier Action

A GitHub Action that monitors pull request checks and notifies when all checks have passed, excluding specified checks (like Atlantis apply).

## Features

- Monitors all PR checks and status updates
- Excludes specified checks (like Atlantis apply)
- Customizable notification message
- Prevents duplicate notifications
- Supports both status checks and check runs
- Detailed logging for debugging

## Usage

```yaml
name: PR Check Monitor

on:
  pull_request:
    types: [opened, synchronize, reopened]
  status:

permissions:
  pull-requests: write
  checks: read
  statuses: read

jobs:
  monitor-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: yourusername/pr-status-notifier@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: customize excluded checks
          excluded-checks: atlantis/apply,Check Status & Notify
          # Optional: customize notification message
          notification-message: '@{user} All checks have passed! Ready for review! 🎉'
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github-token` | GitHub token for API access | Yes | `${{ github.token }}` |
| `excluded-checks` | Comma-separated list of check names to exclude | No | `atlantis/apply,Check Status & Notify` |
| `notification-message` | Custom notification message (use {user} for PR owner mention) | No | Default message about checks passing |
| `poll-interval` | Polling interval in seconds | No | 30
| `timeout` | Maximum time to wait in minutes | No | 30

## Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Make your changes in `src/index.js`
4. Build the action:
   ```bash
   npm run build
   ```

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) first.

## License

GPLv3