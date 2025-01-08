class NotificationStore {
  constructor() {
    this.notifications = new Set();
  }

  hasNotification(prNumber) {
    return this.notifications.has(`pr-${prNumber}`);
  }

  addNotification(prNumber) {
    this.notifications.add(`pr-${prNumber}`);
  }
}

module.exports = new NotificationStore();