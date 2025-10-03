const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AuditModel {
  static async find(filter, options = {}) {
    const db = getDB();
    const { skip = 0, limit = 100, projection = {} } = options;
    
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
      { $project: projection },
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: limit }
    ]).toArray();
  }

  static async countDocuments(filter) {
    const db = getDB();
    return await db.collection('audit_trail').countDocuments(filter);
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

  static async getAnalysisStats(filter) {
    const db = getDB();
    return await db.collection('audit_trail').aggregate([
      {
        $match: {
          ...filter,
          event_type: 'analysis_generated'
        }
      },
      {
        $group: {
          _id: '$event_data.analysis_type',
          count: { $sum: 1 },
          latest: { $max: '$timestamp' }
        }
      }
    ]).toArray();
  }
}

module.exports = AuditModel;