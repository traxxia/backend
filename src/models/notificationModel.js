const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class NotificationModel {
  static collection() {
    return getDB().collection('notifications');
  }

  static async setupIndexes() {
    try {
      const coll = this.collection();
      await coll.createIndex({ user_id: 1 });
      await coll.createIndex({ is_read: 1 });
      await coll.createIndex({ user_id: 1, is_read: 1 });
      // 30-Day TTL Index: 30 * 24 * 60 * 60 = 2592000 seconds
      await coll.createIndex({ created_at: 1 }, { expireAfterSeconds: 2592000 });
      console.log('Notification indexes established successfully.');
    } catch (error) {
      console.error('Failed to establish Notification indexes:', error);
    }
  }

  static async create(data) {
    const coll = this.collection();
    const result = await coll.insertOne({
      user_id: new ObjectId(String(data.user_id)),
      type: data.type || 'stale_bet',
      title: data.title,
      message: data.message,
      is_read: false,
      action_data: data.action_data || {},
      created_at: new Date()
    });
    return result.insertedId;
  }

  static async findUnreadByUser(userId) {
    return await this.collection()
      .find({
        user_id: new ObjectId(String(userId)),
        is_read: false
      })
      .sort({ created_at: -1 })
      .toArray();
  }

  static async findRecentByUser(userId, limit = 50) {
    return await this.collection()
      .find({
        user_id: new ObjectId(String(userId))
      })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  }

  static async markAsRead(notificationId, userId) {
    return await this.collection().updateOne(
      { _id: new ObjectId(String(notificationId)), user_id: new ObjectId(String(userId)) },
      { $set: { is_read: true } }
    );
  }

  static async markAllAsRead(userId) {
    return await this.collection().updateMany(
      { user_id: new ObjectId(String(userId)), is_read: false },
      { $set: { is_read: true } }
    );
  }

  static async delete(notificationId, userId) {
    return await this.collection().deleteOne({ 
      _id: new ObjectId(String(notificationId)),
      user_id: new ObjectId(String(userId))
    });
  }

  static async findExistingUnreadNotification(userId, type, projectId) {
    return await this.collection().findOne({
      user_id: new ObjectId(String(userId)),
      type: type,
      is_read: false,
      "action_data.project_id": projectId.toString()
    });
  }
}

module.exports = NotificationModel;
