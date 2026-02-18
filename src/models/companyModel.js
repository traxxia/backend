const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class CompanyModel {
  static async create(companyData) {
    const db = getDB();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt);
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    const result = await db.collection('companies').insertOne({
      ...companyData,
      status: 'active',
      subscription_status: 'active',
      stripe_customer_id: companyData.stripe_customer_id || null,
      stripe_subscription_id: companyData.stripe_subscription_id || null,
      stripe_payment_method_id: companyData.stripe_payment_method_id || null,
      created_at: createdAt,
      expires_at: expiresAt
    });
    return result.insertedId;
  }

  static async findByName(normalizedName) {
    const db = getDB();
    return await db.collection('companies').findOne({
      company_name_normalized: normalizedName,
      // status: { $ne: 'inactive' } 
    });
  }

  static async findAll(filter = {}) {
    const db = getDB();
    return await db.collection('companies').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          let: { companyId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$company_id', '$$companyId'] },
                role_id: { $exists: true }
              }
            },
            {
              $lookup: {
                from: 'roles',
                localField: 'role_id',
                foreignField: '_id',
                as: 'role'
              }
            },
            { $unwind: '$role' },
            { $match: { 'role.role_name': 'company_admin' } },
            { $limit: 1 }
          ],
          as: 'admin'
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: 'company_id',
          as: 'users'
        }
      },
      {
        $addFields: {
          admin_name: { $arrayElemAt: ['$admin.name', 0] },
          admin_email: { $arrayElemAt: ['$admin.email', 0] },
          admin_created_at: { $arrayElemAt: ['$admin.created_at', 0] },
          total_users: { $size: '$users' },
          active_users: {
            $size: {
              $filter: {
                input: '$users',
                cond: { $ne: ['$$this.status', 'inactive'] }
              }
            }
          }
        }
      },
      {
        $project: {
          company_name: 1,
          industry: 1,
          size: 1,
          logo: 1,
          status: 1,
          created_at: 1,
          logo_updated_at: 1,
          admin_name: 1,
          admin_email: 1,
          admin_created_at: 1,
          total_users: 1,
          active_users: 1
        }
      },
      { $sort: { created_at: -1 } }
    ]).toArray();
  }

  static async findActive() {
    const db = getDB();
    return await db.collection('companies')
      .find({ status: 'active' })
      .project({ company_name: 1, industry: 1, logo: 1 })
      .sort({ company_name: 1 })
      .toArray();
  }

  static async updateLogo(companyId, logoUrl) {
    const db = getDB();
    return await db.collection('companies').updateOne(
      { _id: new ObjectId(companyId) },
      {
        $set: {
          logo: logoUrl,
          logo_updated_at: new Date()
        }
      }
    );
  }
}

module.exports = CompanyModel;