const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class PlanModel {
  static async getAll() {
    const db = getDB();
    return await db.collection('plans').find({ status: 'active' }).toArray();
  }

  static async findById(planId) {
    const db = getDB();
    if (!ObjectId.isValid(planId)) return null;
    return await db.collection('plans').findOne({ _id: new ObjectId(planId) });
  }

  static async findByName(name) {
    const db = getDB();
    return await db.collection('plans').findOne({ name });
  }

  static async update(planId, planData) {
    const db = getDB();
    if (!ObjectId.isValid(planId)) throw new Error('Invalid plan ID');
    
    return await db.collection('plans').updateOne(
      { _id: new ObjectId(planId) },
      { 
        $set: { 
          ...planData, 
          updated_at: new Date() 
        } 
      }
    );
  }

  static async create(planData) {
    const db = getDB();
    const result = await db.collection('plans').insertOne({
      ...planData,
      status: 'active',
      created_at: new Date()
    });
    return result.insertedId;
  }
}

module.exports = PlanModel;
