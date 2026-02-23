const { ObjectId } = require("mongodb");
const PMFAnalysisModel = require("../models/pmfAnalysisModel");

class PMFAnalysisController {
    static async saveOnboardingData(req, res) {
        try {
            const { businessId, onboardingData } = req.body;
            const userId = req.user._id;

            if (!businessId || !onboardingData) {
                return res.status(400).json({ error: "Business ID and onboarding data are required" });
            }

            await PMFAnalysisModel.upsertOnboardingData(businessId, userId, onboardingData);

            res.json({ message: "PMF onboarding data saved successfully" });
        } catch (error) {
            console.error("Error saving PMF onboarding data:", error);
            res.status(500).json({ error: "Failed to save PMF onboarding data" });
        }
    }

    static async getPMFAnalysis(req, res) {
        try {
            const { businessId } = req.params;

            if (!ObjectId.isValid(businessId)) {
                return res.status(400).json({ error: "Invalid business ID" });
            }

            const analysis = await PMFAnalysisModel.findByBusinessId(businessId);

            if (!analysis) {
                return res.status(404).json({ error: "PMF analysis not found" });
            }

            res.json(analysis);
        } catch (error) {
            console.error("Error fetching PMF analysis:", error);
            res.status(500).json({ error: "Failed to fetch PMF analysis" });
        }
    }

    static async saveInsights(req, res) {
        try {
            const { businessId } = req.params;
            const { insights } = req.body;

            if (!businessId || !insights) {
                return res.status(400).json({ error: "Business ID and insights are required" });
            }

            await PMFAnalysisModel.updateInsights(businessId, insights);

            res.json({ message: "PMF insights saved successfully" });
        } catch (error) {
            console.error("Error saving PMF insights:", error);
            res.status(500).json({ error: "Failed to save PMF insights" });
        }
    }
}

module.exports = PMFAnalysisController;
