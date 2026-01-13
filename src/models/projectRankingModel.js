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
            ...(r.rank !== undefined ? { rank: r.rank } : {}),
            updated_at: new Date(),
          },
          $setOnInsert: {
            locked: r.locked || false,
            created_at: new Date(),
          },
        },
        upsert: true,
      },
    }));

    return this.collection().bulkWrite(ops);
  }

  static async lockRank(userId, projectId){
    return this.collection().updateOne(
      { user_id: new ObjectId(userId), project_id: new ObjectId(projectId)},
      {$set: { locked: true, updated_at: new Date()}}

    )
  }

  static async isLocked(userId, projectId){
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

  static async unlockRankingByBusiness(businessId) {
  return this.collection().updateMany(
    { business_id: new ObjectId(businessId) },
    { $set: { locked: false } }
  );
}

static async lockRankingByBusiness(businessId) {
  return this.collection().updateMany(
    { business_id: new ObjectId(businessId) },
    { $set: { locked: true } }
  );
}

}




module.exports = ProjectRankingModel;
