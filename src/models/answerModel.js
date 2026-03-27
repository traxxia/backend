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

  static async bulkCreate(answersData) {
    const db = getDB();
    const formattedAnswers = answersData.map(answer => ({
      ...answer,
      created_at: new Date(),
      updated_at: new Date()
    }));
    const result = await db.collection('answers').insertMany(formattedAnswers);
    return result.insertedIds;
  }

  static async bulkUpdate(answersData) {
    const db = getDB();
    const bulkOps = answersData.map(item => ({
      updateOne: {
        filter: { _id: new ObjectId(item.answer_id) },
        update: {
          $set: {
            answer: item.answer,
            updated_at: new Date()
          }
        }
      }
    }));
    if (bulkOps.length === 0) return { modifiedCount: 0 };
    return await db.collection('answers').bulkWrite(bulkOps);
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
