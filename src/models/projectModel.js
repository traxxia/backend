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

  static async delete(id) {
    return await this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  static async count(filter = {}) {
    return await this.collection().countDocuments(filter);
  }

  // populate created_by field
  static async populateCreatedBy(projects) {
    if (!Array.isArray(projects)) projects = [projects];
    if (projects.length === 0) return projects;

    const userIds = [
      ...new Set(projects.map((p) => p.user_id).filter(Boolean)),
    ];
    if (userIds.length === 0) return projects;

    const users = await Promise.all(
      userIds.map((id) => UserModel.findById(id))
    );

    const userMap = {};
    users.forEach((user) => {
      if (user) {
        const name = user.name?.trim() || user.email || "Unknown User";
        userMap[user._id.toString()] = name;
      }
    });

    return projects.map((project) => ({
      ...project,
      created_by: userMap[project.user_id?.toString()] || "Unknown User",
    }));
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
}

module.exports = ProjectModel;
