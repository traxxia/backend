const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AnswerModel {
  static async create(answerData) {
    const db = getDB();
    const result = await db.collection('answers').insertOne({
      ...answerData,
      created_at: new Date(),
      updated_at: new Date()
    });
    return result.insertedId;
  }

  static async getById(id) {
    const db = getDB();
    return await db.collection('answers').findOne({ _id: new ObjectId(id) });
  }

  static async getByBusinessId(business_id) {
    const db = getDB();
    return await db.collection('answers')
      .find({ business_id: new ObjectId(business_id) })
      .toArray();
  }

  static async update(id, updateData) {
    const db = getDB();
    return await db.collection('answers').updateOne(
      { _id: new ObjectId(id) },
      { 
        $set: {
          ...updateData,
          updated_at: new Date()
        } 
      }
    );
  }
}

module.exports = AnswerModel;
