const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class QuestionModel {
  static async findAll(filter = { is_active: true }) {
    const db = getDB();
    return await db.collection('global_questions')
      .find(filter)
      .sort({ order: 1 })
      .toArray();
  }

  static async findById(questionId) {
    const db = getDB();
    return await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });
  }

  static async create(questionData) {
    const db = getDB();
    const result = await db.collection('global_questions').insertOne({
      ...questionData,
      is_active: true,
      created_at: new Date()
    });
    return result.insertedId;
  }

  static async update(questionId, updateData) {
    const db = getDB();
    return await db.collection('global_questions').updateOne(
      { _id: new ObjectId(questionId) },
      { $set: { ...updateData, updated_at: new Date() } }
    );
  }

  static async delete(questionId) {
    const db = getDB();
    return await db.collection('global_questions')
      .deleteOne({ _id: new ObjectId(questionId) });
  }

  static async bulkWrite(operations) {
    const db = getDB();
    return await db.collection('global_questions')
      .bulkWrite(operations, { ordered: false });
  }

  static async countDocuments(filter = {}) {
    const db = getDB();
    return await db.collection('global_questions').countDocuments(filter);
  }
}

module.exports = QuestionModel;