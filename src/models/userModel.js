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
      created_at: new Date(),
      tour_completed: false
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
          status: 1,
          access_mode: 1,
          inactive_reason: 1,
          inactive_at: 1,
          role_name: '$role.role_name',
          company_name: '$company.company_name',
          company_id: 1
        }
      },
      { $sort: { created_at: -1 } }
    ]).toArray();
  }

  static async updateRole(userId, roleName) {
    const db = getDB();

    const roleDoc = await db.collection("roles").findOne({ role_name: roleName });

    if (!roleDoc) {
      throw new Error(`Role ${roleName} not found`);
    }

    return await db.collection("users").updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          role_id: roleDoc._id,
          status: 'active',
          access_mode: 'active',
          updated_at: new Date(),
        },
      }
    )
  }

  static async completeTour(userId) {
    const db = getDB();
    console.log(`[UserModel] Attempting to mark tour complete for ID: ${userId}`);
    
    // Ensure we handle the ID as a string for robust ObjectId conversion
    const idToUpdate = typeof userId === 'object' ? userId.toString() : userId;

    return await db.collection("users").updateOne(
      { _id: new ObjectId(idToUpdate) },
      {
        $set: {
          tour_completed: true,
          updated_at: new Date(),
        },
      }
    );
  }

  static async setResetOtp(email, otp, expiry) {
    const db = getDB();
    return await db.collection('users').updateOne(
      { email },
      {
        $set: {
          reset_otp: otp,
          reset_otp_expiry: expiry,
          updated_at: new Date()
        }
      }
    );
  }

  static async findByOtp(email, otp) {
    const db = getDB();
    return await db.collection('users').findOne({
      email: email,
      reset_otp: otp,
      reset_otp_expiry: { $gt: new Date() }
    });
  }

  static async resetPassword(userId, newPassword) {
    const db = getDB();
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    return await db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          password: hashedPassword,
          updated_at: new Date()
        },
        $unset: {
          reset_otp: "",
          reset_otp_expiry: ""
        }
      }
    );
  }
}





module.exports = UserModel;