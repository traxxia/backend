const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");
const UserModel = require("./userModel");

class ProjectModel {
  static collection() {
    return getDB().collection("projects");
  }

  static async findAll(filter = {}) {
    return await this.collection()
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();
  }

  static async findById(id) {
    return await this.collection().findOne({ _id: new ObjectId(id) });
  }

  static async create(data) {
    const coll = this.collection();
    const now = new Date();
    const result = await coll.insertOne({
      ...data,
      created_at: now,
      updated_at: now,
    });
    return result.insertedId;
  }

  static async update(id, updateData) {
    return await this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updated_at: new Date() } }
    );
  }

  static async updateAndReturn(id, updateData) {
    const result = await this.collection().findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    // Handle both old and new driver return formats
    return result?.value || result;
  }

  static async delete(id) {
    return await this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  static async count(filter = {}) {
    return await this.collection().countDocuments(filter);
  }

  // populate created_by field
  static async populateCreatedBy(projects) {
    const isArray = Array.isArray(projects);
    const projectsArray = isArray ? projects : [projects];
    if (projectsArray.length === 0) return projects;

    const userIds = [
      ...new Set(projectsArray.map((p) => p.user_id?.toString()).filter(Boolean)),
    ];
    
    if (userIds.length === 0) {
      const result = projectsArray.map(p => ({ ...p, created_by: "Unknown User" }));
      return isArray ? result : result[0];
    }

    // Optimization: Fetch all users in one query instead of multiple findById calls
    const users = await UserModel.getAll({ _id: { $in: userIds.map(id => new ObjectId(id)) } });

    const userMap = {};
    users.forEach((user) => {
      if (user) {
        userMap[user._id.toString()] = (user.name || "").trim() || "User";
      }
    });

    const enriched = projectsArray.map((project) => ({
      ...project,
      created_by: userMap[project.user_id?.toString()] || "Unknown User",
    }));

    return isArray ? enriched : enriched[0];
  }

  static async setAllowedCollaborators(projectId, collaboratorIds) {
    return await this.collection().updateOne(
      { _id: new ObjectId(projectId) },
      { $set: { allowed_collaborators: collaboratorIds.map(id => new ObjectId(id)), updated_at: new Date() } }
    );
  }

  static async getAllowedCollaborators(projectId) {
    const project = await this.findById(projectId);
    return project?.allowed_collaborators || [];
  }

  static async clearAllowedCollaborators(projectId) {
    return await this.collection().updateOne(
      { _id: new ObjectId(projectId) },
      { $set: { allowed_collaborators: [], updated_at: new Date() } }
    );
  }
  static async updateAIRank(projectId, rankData) {
    return await this.collection().updateOne(
      { _id: new ObjectId(projectId) },
      {
        $set: {
          ai_rank: rankData.rank,
          ai_rank_score: rankData.score || null,
          ai_rank_factors: rankData.factors || {},
          ...(rankData.impact && { impact: rankData.impact }),
          ...(rankData.effort && { effort: rankData.effort }),
          ...(rankData.risk && { risk: rankData.risk }),
          updated_at: new Date(),
        },
      }
    );
  }

  static async bulkUpdateAIRanks(rankingsArray) {
    // rankingsArray format: [{ project_id, rank, score, factors }, ...]
    const bulkOps = rankingsArray.map(ranking => ({
      updateOne: {
        filter: { _id: new ObjectId(ranking.project_id) },
        update: {
          $set: {
            ai_rank: ranking.rank,
            ai_rank_score: ranking.score || null,
            ai_rank_factors: ranking.factors || {},
            ...(ranking.impact && { impact: ranking.impact }),
            ...(ranking.effort && { effort: ranking.effort }),
            ...(ranking.risk && { risk: ranking.risk }),
            updated_at: new Date(),
          },
        },
      },
    }));

    return await this.collection().bulkWrite(bulkOps);
  }

  static async getProjectsWithAIRanks(businessId) {
    return await this.collection()
      .find({
        business_id: new ObjectId(businessId),
        ai_rank: { $exists: true, $ne: null }
      })
      .sort({ ai_rank: 1 }) // Sort by AI rank
      .toArray();
  }
  static async removeFromAllowedCollaborators(businessId, userId) {
    return await this.collection().updateMany(
      { business_id: new ObjectId(businessId) },
      { $pull: { allowed_collaborators: new ObjectId(userId) }, $set: { updated_at: new Date() } }
    );
  }
  static async revokeProjectEditAccessGlobally(userId) {
    return await this.collection().updateMany(
      { allowed_collaborators: new ObjectId(userId) },
      { $pull: { allowed_collaborators: new ObjectId(userId) }, $set: { updated_at: new Date() } }
    );
  }

  static async reassignOwnership(businessId, oldOwnerId, newOwnerId, newOwnerName) {
    return await this.collection().updateMany(
      { 
        business_id: new ObjectId(businessId), 
        $or: [
          { user_id: new ObjectId(oldOwnerId) },
          { accountable_owner_id: new ObjectId(oldOwnerId) }
        ]
      },
      { 
        $set: { 
          user_id: new ObjectId(newOwnerId), 
          accountable_owner_id: new ObjectId(newOwnerId),
          accountable_owner: newOwnerName,
          updated_at: new Date() 
        } 
      }
    );
  }
}

module.exports = ProjectModel;
