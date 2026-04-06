const NotificationModel = require('../models/notificationModel');

class NotificationController {
  static async getNotifications(req, res) {
    try {
      const userId = req.user._id || req.user.id;
      const limit = parseInt(req.query.limit) || 50;
      
      const notifications = await NotificationModel.findRecentByUser(userId, limit);
      const unreadCount = notifications.filter(n => !n.is_read).length;
      
      res.json({
        notifications,
        unread_count: unreadCount,
        has_unread: unreadCount > 0
      });
    } catch (error) {
      console.error('Error fetching notifications:', error);
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  }

  static async markAsRead(req, res) {
    try {
      const userId = req.user._id || req.user.id;
      const { id } = req.params;
      
      const result = await NotificationModel.markAsRead(id, userId);
      
      if (result.matchedCount === 0) {
         return res.status(404).json({ error: 'Notification not found or unauthorized' });
      }
      
      res.json({ message: 'Notification marked as read' });
    } catch (error) {
      console.error('Error marking notification as read:', error);
      res.status(500).json({ error: 'Failed to mark notification as read' });
    }
  }

  static async markAllAsRead(req, res) {
    try {
      const userId = req.user._id || req.user.id;
      
      await NotificationModel.markAllAsRead(userId);
      
      res.json({ message: 'All notifications marked as read' });
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      res.status(500).json({ error: 'Failed to mark all notifications as read' });
    }
  }
  static async deleteNotification(req, res) {
    try {
      const userId = req.user._id || req.user.id;
      const { id } = req.params;

      const result = await NotificationModel.delete(id, userId);
      
      if (result.deletedCount === 0) {
         return res.status(404).json({ error: 'Notification not found or unauthorized' });
      }

      res.json({ message: 'Notification deleted' });
    } catch (error) {
      console.error('Error deleting notification:', error);
      res.status(500).json({ error: 'Failed to delete notification' });
    }
  }
}

module.exports = NotificationController;
