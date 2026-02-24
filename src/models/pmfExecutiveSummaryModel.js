const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class PMFExecutiveSummaryModel {
    static collection() {
        return getDB().collection("pmf_executive_summaries");
    }

    static async upsertSummary(businessId, userId, summary) {
        return await this.collection().updateOne(
            { business_id: new ObjectId(businessId) },
            {
                $set: {
                    user_id: new ObjectId(userId),
                    summary: summary,
                    updated_at: new Date()
                },
                $setOnInsert: {
                    created_at: new Date()
                }
            },
            { upsert: true }
        );
    }

    static async findByBusinessId(businessId) {
        return await this.collection().findOne({
            business_id: new ObjectId(businessId)
        });
    }
}

module.exports = PMFExecutiveSummaryModel;
