const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const { MAX_BUSINESSES_PER_USER } = require('../config/constants');

class BusinessModel {
  static async create(businessData) {
    const db = getDB();
    const result = await db.collection('user_businesses').insertOne({
      ...businessData,
      created_at: new Date(),
      updated_at: new Date()
    });
    return result.insertedId;
  }

  static async findByUserId(userId) {
    const db = getDB();
    return await db.collection('user_businesses')
      .find({ user_id: new ObjectId(userId) })
      .sort({ created_at: -1 })
      .toArray();
  }

  static async findById(businessId, userId) {
    const db = getDB();
    return await db.collection('user_businesses').findOne({
      _id: new ObjectId(businessId),
      user_id: new ObjectId(userId)
    });
  }

  static async countByUserId(userId) {
    const db = getDB();
    return await db.collection('user_businesses')
      .countDocuments({ user_id: new ObjectId(userId) });
  }

  static async delete(businessId, userId) {
    const db = getDB();
    return await db.collection('user_businesses').deleteOne({
      _id: new ObjectId(businessId),
      user_id: new ObjectId(userId)
    });
  }

  static async updateDocument(businessId, documentData) {
    const db = getDB();
    return await db.collection('user_businesses').updateOne(
      { _id: new ObjectId(businessId) },
      {
        $set: {
          financial_document: documentData,
          has_financial_document: true,
          updated_at: new Date()
        }
      }
    );
  }

  static async updateUploadDecision(businessId, decision) {
    const db = getDB();
    const updateData = {
      updated_at: new Date()
    };

    if (decision === 'pending') {
      updateData.upload_decision_made = false;
      updateData.upload_decision = 'pending';
    } else {
      updateData.upload_decision_made = true;
      updateData.upload_decision = decision;
    }

    return await db.collection('user_businesses').updateOne(
      { _id: new ObjectId(businessId) },
      { $set: updateData }
    );
  }
}

module.exports = BusinessModel;