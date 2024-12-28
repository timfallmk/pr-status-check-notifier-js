class NotificationStore {
  constructor() {
    this.notifications = new Set();
  }

  hasNotification(prNumber, message) {
    return this.notifications.has(`pr-${prNumber}-${message}`);
  }

  addNotification(prNumber, message) {
    this.notifications.add(`pr-${prNumber}-${message}`);
  }
}

module.exports = new NotificationStore();