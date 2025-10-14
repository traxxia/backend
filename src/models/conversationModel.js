const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class ConversationModel {
  static async create(conversationData) {
    const db = getDB();
    const result = await db.collection('user_business_conversations').insertOne({
      ...conversationData,
      timestamp: new Date(),
      created_at: new Date()
    });
    return result.insertedId;
  }

  static async findByFilter(filter) {
    const db = getDB();
    return await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: 1 })
      .toArray();
  }

  static async replaceOne(filter, updateDoc, options = {}) {
    const db = getDB();
    return await db.collection('user_business_conversations')
      .replaceOne(filter, updateDoc, options);
  }

  static async updateOne(filter, update, options = {}) {
    const db = getDB();
    return await db.collection('user_business_conversations')
      .updateOne(filter, update, options);
  }

  static async deleteMany(filter) {
    const db = getDB();
    return await db.collection('user_business_conversations')
      .deleteMany(filter);
  }

  static async countDocuments(filter) {
    const db = getDB();
    return await db.collection('user_business_conversations')
      .countDocuments(filter);
  }
}

module.exports = ConversationModel;