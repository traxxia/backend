const { ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const { getDB } = require('../config/database');

class UserModel {
  static async findByEmail(email) {
    const db = getDB();
    return await db.collection('users').findOne({ email });
  }

  static async findById(userId) {
    const db = getDB();
    return await db.collection('users').findOne({ _id: new ObjectId(userId) });
  }

  static async create(userData) {
    const db = getDB();
    const hashedPassword = await bcrypt.hash(userData.password, 12);
    
    const result = await db.collection('users').insertOne({
      ...userData,
      password: hashedPassword,
      created_at: new Date()
    });
    
    return result.insertedId;
  }

  static async comparePassword(plainPassword, hashedPassword) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }

  static async getAll(filter = {}) {
    const db = getDB();
    return await db.collection('users').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'roles',
          localField: 'role_id',
          foreignField: '_id',
          as: 'role'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      { $unwind: { path: '$role', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          email: 1,
          created_at: 1,
          role_name: '$role.role_name',
          company_name: '$company.company_name',
          company_id: 1
        }
      },
      { $sort: { created_at: -1 } }
    ]).toArray();
  }
}

module.exports = UserModel;