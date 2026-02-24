const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AuditModel {
  static async find(filter, options = {}) {
    const db = getDB();
    const { skip = 0, limit = 100, projection = {}, searchFilter = {} } = options;

    return await db.collection('audit_trail').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'user.company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          temp_business_id: {
            $cond: {
              if: { $ne: ["$event_data.business_id", null] },
              then: { $toObjectId: "$event_data.business_id" },
              else: {
                $cond: {
                  if: { $ne: ["$additional_info.business_id", null] },
                  then: { $toObjectId: "$additional_info.business_id" },
                  else: null
                }
              }
            }
          }
        }
      },
      {
        $lookup: {
          from: 'businesses',
          localField: 'temp_business_id',
          foreignField: '_id',
          as: 'business'
        }
      },
      { $unwind: { path: '$business', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          user_name: "$user.name",
          user_email: "$user.email",
          company_name: "$company.company_name",
          business_name: "$business.business_name"
        }
      },
      { $match: searchFilter },
      { $project: projection },
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: limit }
    ]).toArray();
  }

  static async countDocuments(filter, searchFilter = {}) {
    const db = getDB();
    if (Object.keys(searchFilter).length === 0) {
      return await db.collection('audit_trail').countDocuments(filter);
    }

    // If we have a search filter, we need an aggregate to handle looked up fields
    const countResult = await db.collection('audit_trail').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'user.company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          user_name: "$user.name",
          user_email: "$user.email",
          company_name: "$company.company_name"
        }
      },
      { $match: searchFilter },
      { $count: "total" }
    ]).toArray();

    return countResult[0]?.total || 0;
  }

  static async findById(auditId) {
    const db = getDB();
    return await db.collection('audit_trail')
      .findOne({ _id: new ObjectId(auditId) });
  }

  static async getEventTypes() {
    const db = getDB();
    return await db.collection('audit_trail').distinct('event_type');
  }

  static async getAnalysisStats(filter, searchFilter = {}) {
    const db = getDB();
    const pipeline = [
      { $match: { ...filter, event_type: 'analysis_generated' } }
    ];

    if (Object.keys(searchFilter).length > 0) {
      pipeline.push(
        {
          $addFields: {
            temp_business_id: {
              $cond: {
                if: { $ne: ["$event_data.business_id", null] },
                then: { $toObjectId: "$event_data.business_id" },
                else: {
                  $cond: {
                    if: { $ne: ["$additional_info.business_id", null] },
                    then: { $toObjectId: "$additional_info.business_id" },
                    else: null
                  }
                }
              }
            }
          }
        },
        {
          $lookup: {
            from: 'businesses',
            localField: 'temp_business_id',
            foreignField: '_id',
            as: 'business'
          }
        },
        { $unwind: { path: '$business', preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            user_name: "$user.name",
            user_email: "$user.email",
            company_name: "$company.company_name",
            business_name: "$business.business_name"
          }
        },
        { $match: searchFilter }
      );
    }

    pipeline.push({
      $group: {
        _id: '$event_data.analysis_type',
        count: { $sum: 1 },
        latest: { $max: '$timestamp' }
      }
    });

    return await db.collection('audit_trail').aggregate(pipeline).toArray();
  }
}

module.exports = AuditModel;