const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class SessionStateModel {
  static collection() {
    return getDB().collection("doc_intelligence_sessions");
  }

  // Create a new session state document
  static async create(sessionData) {
    const { businessId } = sessionData;
    const result = await this.collection().insertOne({
      ...sessionData,
      businessId: new ObjectId(businessId),
      created_at: new Date(),
      updated_at: new Date()
    });
    return result.insertedId;
  }

  // Save or update the finalized raw JSON response directly in the session record
  static async saveRaw(businessId, status, strategicAnswers, financialMetrics) {
    const query = { businessId: new ObjectId(businessId) };
    const update = {
      $set: {
        status: status,
        strategicAnswers: strategicAnswers,
        financialMetrics: financialMetrics,
        updated_at: new Date()
      },
      $setOnInsert: {
        created_at: new Date()
      }
    };
    
    return await this.collection().updateOne(query, update, { upsert: true });
  }

  // Find active session by business id
  static async findByBusinessId(businessId) {
    return await this.collection().findOne({
      businessId: new ObjectId(businessId)
    });
  }

  // Get all session records
  static async getAll(businessId) {
    return await this.collection()
      .find({ businessId: new ObjectId(businessId) })
      .sort({ updated_at: -1 })
      .toArray();
  }
}

module.exports = SessionStateModel;
