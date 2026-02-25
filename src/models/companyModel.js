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
      ai_token_usage: 0,
      quotaExceed: false,
      quotaResetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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

  static async getAITokenUsage(companyId) {
    const db = getDB();
    const company = await db.collection('companies').findOne({ _id: new ObjectId(companyId) });
    
    if (!company) {
      throw new Error('Company not found');
    }

    const now = new Date();
    let currentUsage = company.ai_token_usage || 0;
    let resetAt = company.quotaResetAt;
    let quotaExceed = company.quotaExceed || false;
    let updated = false;

    // If quotaResetAt is missing or has passed, reset the cycle
    if (!resetAt || now > new Date(resetAt)) {
      currentUsage = 0;
      resetAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      quotaExceed = false;
      updated = true;
    }

    if (updated) {
      await db.collection('companies').updateOne(
        { _id: new ObjectId(companyId) },
        {
          $set: {
            ai_token_usage: currentUsage,
            quotaExceed,
            quotaResetAt: resetAt,
            updated_at: now
          }
        }
      );
    }

    return {
      ai_token_usage: currentUsage,
      quotaExceed,
      quotaResetAt: resetAt
    };
  }

  static async updateAITokenUsage(companyId, tokensUsed) {
    const db = getDB();
    const company = await db.collection('companies').findOne({ _id: new ObjectId(companyId) });
    
    if (!company) {
      throw new Error('Company not found');
    }

    const now = new Date();
    let currentUsage = company.ai_token_usage || 0;
    let resetAt = company.quotaResetAt;

    // If quotaResetAt is missing or has passed, reset the cycle
    if (!resetAt || now > new Date(resetAt)) {
      currentUsage = 0;
      resetAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    }

    currentUsage += tokensUsed;
    const limit = 3000000;
    const quotaExceed = currentUsage >= limit;

    await db.collection('companies').updateOne(
      { _id: new ObjectId(companyId) },
      {
        $set: {
          ai_token_usage: currentUsage,
          quotaExceed,
          quotaResetAt: resetAt,
          updated_at: now
        }
      }
    );

    return {
      quotaExceed,
      quotaResetAt: resetAt
    };
  }
}

module.exports = CompanyModel;