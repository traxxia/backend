const { ObjectId } = require("mongodb");
const PMFAnalysisModel = require("../models/pmfAnalysisModel");
const PMFExecutiveSummaryModel = require("../models/pmfExecutiveSummaryModel");

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

    static async saveExecutiveSummary(req, res) {
        try {
            const { businessId } = req.params;
            const { summary } = req.body;
            const userId = req.user._id;

            if (!businessId || !summary) {
                return res.status(400).json({ error: "Business ID and summary are required" });
            }

            await PMFExecutiveSummaryModel.upsertSummary(businessId, userId, summary);

            res.json({ message: "PMF executive summary saved successfully" });
        } catch (error) {
            console.error("Error saving PMF executive summary:", error);
            res.status(500).json({ error: "Failed to save PMF executive summary" });
        }
    }

    static async getExecutiveSummary(req, res) {
        try {
            const { businessId } = req.params;

            if (!ObjectId.isValid(businessId)) {
                return res.status(400).json({ error: "Invalid business ID" });
            }

            const summary = await PMFExecutiveSummaryModel.findByBusinessId(businessId);

            if (!summary) {
                return res.status(404).json({ error: "PMF executive summary not found" });
            }

            res.json(summary);
        } catch (error) {
            console.error("Error fetching PMF executive summary:", error);
            res.status(500).json({ error: "Failed to fetch PMF executive summary" });
        }
    }
}

module.exports = PMFAnalysisController;
