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

  static async findByUserAndBusiness(userId, businessId) {
    return this.collection()
      .find({
        user_id: new ObjectId(userId),
        business_id: new ObjectId(businessId),
      })
      .sort({ rank: 1 })
      .toArray();
  }
}

module.exports = ProjectRankingModel;
