const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class ProjectRankingModel {
  static collection() {
    return getDB().collection("project_rankings");
  }

  static async bulkUpsert(rankings) {
    const ops = rankings.map(r => ({
      updateOne: {
        filter: {
          user_id: r.user_id,
          business_id: r.business_id,
          project_id: r.project_id,
        },
        update: {
          $set: {
            rank: r.rank,
            rationals: r.rationals,
            locked: r.locked !== undefined ? r.locked : true,
            updated_at: new Date(),
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        upsert: true,
      },
    }));

    return this.collection().bulkWrite(ops);
  }

  static async lockRank(userId, projectId) {
    return this.collection().updateOne(
      { user_id: new ObjectId(userId), project_id: new ObjectId(projectId) },
      { $set: { locked: true, updated_at: new Date() } }

    )
  }

  static async isLocked(userId, projectId) {
    const doc = await this.collection().findOne({
      user_id: new ObjectId(userId),
      project_id: new ObjectId(projectId)
    })
    return doc?.locked === true;
  }

  static async findByUserAndBusiness(userId, businessId) {
    return this.collection()
      .find({
        user_id: new ObjectId(userId),
        business_id: new ObjectId(businessId),
      })
      .sort({ rank: 1 })
      .toArray();
  }

  static async lockRankingByUserAndBusiness(userId, businessId) {
    const db = getDB();
    const projects = await db.collection("projects").find({ 
      business_id: new ObjectId(businessId) 
    }).toArray();
    
    if (projects.length === 0) return;

    const ops = projects.map(p => ({
      updateOne: {
        filter: { 
          user_id: new ObjectId(userId), 
          business_id: new ObjectId(businessId),
          project_id: p._id 
        },
        update: { 
          $set: { locked: true, updated_at: new Date() },
          $setOnInsert: { created_at: new Date() }
        },
        upsert: true
      }
    }));
    
    return this.collection().bulkWrite(ops);
  }

  static async deleteRankingsByBusiness(businessId) {
    return this.collection().deleteMany({
      business_id: new ObjectId(businessId)
    });
  }

  static async unlockRankingByBusiness(businessId) {
    return this.collection().updateMany(
      { business_id: new ObjectId(businessId) },
      { $set: { locked: false } }
    );
  }

  static async unlockRankingByUserAndBusiness(userId, businessId) {
    return this.collection().updateMany(
      { 
        user_id: new ObjectId(userId), 
        business_id: new ObjectId(businessId) 
      },
      { $set: { locked: false } }
    );
  }

  static async lockRankingByBusiness(businessId) {
    return this.collection().updateMany(
      { business_id: new ObjectId(businessId) },
      { $set: { locked: true } }
    );
  }

  static async clearRankingsForProject(projectId) {
    return this.collection().updateMany(
      { project_id: new ObjectId(projectId) },
      { $set: { rank: null, updated_at: new Date() } }
    );
  }

}

module.exports = ProjectRankingModel;
