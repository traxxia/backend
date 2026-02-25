const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class PMFAnalysisModel {
    static collection() {
        return getDB().collection("pmf_analyses");
    }

    static async upsertOnboardingData(businessId, userId, onboardingData) {
        const db = getDB();
        return await this.collection().updateOne(
            { business_id: new ObjectId(businessId) },
            {
                $set: {
                    user_id: new ObjectId(userId),
                    onboarding_data: onboardingData,
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

    static async updateInsights(businessId, insights) {
        return await this.collection().updateOne(
            { business_id: new ObjectId(businessId) },
            {
                $set: {
                    insights: insights,
                    insights_generated_at: new Date(),
                    updated_at: new Date()
                }
            }
        );
    }
}

module.exports = PMFAnalysisModel;
