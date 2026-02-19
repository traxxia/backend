const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");
const { MAX_BUSINESSES_PER_USER } = require("../config/constants");

class BusinessModel {
  static collection() {
    return getDB().collection("user_businesses");
  }

  static async create(businessData) {
    const db = getDB();
    const result = await db.collection("user_businesses").insertOne({
      ...businessData,
      created_at: new Date(),
      updated_at: new Date(),
      collaborators: businessData.collaborators || [],
    });
    return result.insertedId;
  }

  static async findByUserId(userId) {
    return await this.collection()
      .find({ user_id: new ObjectId(userId) })
      .sort({ created_at: -1 })
      .toArray();
  }

  static async findByUserIds(userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return [];
    }

    return await this.collection()
      .find({
        user_id: { $in: userIds },
      })
      .sort({ created_at: -1 })
      .toArray();
  }


  // owner-scoped lookup used in some existing flows (delete/update by owner)
  static async findByIdOwnerScoped(businessId, userId) {
    return await this.collection().findOne({
      _id: new ObjectId(businessId),
      user_id: new ObjectId(userId),
    });
  }

  // public lookup by id (no owner constraint)
  static async findById(businessId) {
    return await this.collection().findOne({ _id: new ObjectId(businessId) });
  }

  static async findByCollaborator(userId) {
    return await this.collection()
      .find({ collaborators: new ObjectId(userId) })
      .sort({ created_at: -1 })
      .toArray();
  }

  static async countByUserId(userId) {
    return await this.collection().countDocuments({
      user_id: new ObjectId(userId),
      status: { $ne: 'deleted' }
    });
  }

  static async findLastDeleted(userId) {
    return await this.collection()
      .find({ user_id: new ObjectId(userId), status: 'deleted' })
      .sort({ deleted_at: -1 })
      .limit(1)
      .next();
  }

  static async countCreatedAfter(userId, date) {
    return await this.collection().countDocuments({
      user_id: new ObjectId(userId),
      created_at: { $gt: date },
      status: { $ne: 'deleted' }
    });
  }

  static async delete(businessId, userId) {
    return await this.collection().updateOne(
      {
        _id: new ObjectId(businessId),
        user_id: new ObjectId(userId),
      },
      {
        $set: {
          status: 'deleted',
          deleted_at: new Date(),
          updated_at: new Date()
        }
      }
    );
  }

  static async updateDocument(businessId, documentData) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $set: {
          financial_document: documentData,
          has_financial_document: true,
          updated_at: new Date(),
        },
      }
    );
  }

  static async updateUploadDecision(businessId, decision) {
    const updateData = { updated_at: new Date() };

    if (decision === "pending") {
      updateData.upload_decision_made = false;
      updateData.upload_decision = "pending";
    } else {
      updateData.upload_decision_made = true;
      updateData.upload_decision = decision;
    }

    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      { $set: updateData }
    );
  }

  // collaborator helpers
  static async addCollaborator(businessId, collaboratorUserId) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $addToSet: { collaborators: new ObjectId(collaboratorUserId) },
        $set: { updated_at: new Date() },
      }
    );
  }

  static async removeCollaborator(businessId, collaboratorUserId) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $pull: { collaborators: new ObjectId(collaboratorUserId) },
        $set: { updated_at: new Date() },
      }
    );
  }

  static async setAllowedRankingCollaborators(businessId, collaboratorIds) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $set: {
          allowed_ranking_collaborators: collaboratorIds.map(id => new ObjectId(id)),
          updated_at: new Date(),
        },
      }
    );
  }

  static async getAllowedRankingCollaborators(businessId) {
    const business = await this.findById(businessId);
    return business?.allowed_ranking_collaborators || [];
  }

  static async clearAllowedRankingCollaborators(businessId) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $set: {
          allowed_ranking_collaborators: [],
          updated_at: new Date(),
        },
      }
    );
  }

  static async saveAIRankingSession(businessId, rankingData) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $set: {
          ai_ranking_session: {
            generated_at: new Date(),
            generated_by: new ObjectId(rankingData.admin_id),
            model_version: rankingData.model_version || "v1.0",
            total_projects: rankingData.total_projects,
            metadata: rankingData.metadata || {}
          },
          updated_at: new Date(),
        },
      }
    );
  }

  static async getAIRankingSession(businessId) {
    const business = await this.findById(businessId);
    return business?.ai_ranking_session || null;
  }

  static async clearAIRankingSession(businessId) {
    return await this.collection().updateOne(
      { _id: new ObjectId(businessId) },
      {
        $unset: { ai_ranking_session: "" },
        $set: { updated_at: new Date() },
      }
    );
  }

}

module.exports = BusinessModel;
