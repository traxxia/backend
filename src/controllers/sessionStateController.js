const SessionStateModel = require("../models/sessionStateModel");

class SessionStateController {
  
  // POST /api/sessions/save-raw
  static async saveRaw(req, res) {
    try {
      const { businessId, status, strategicAnswers, financialMetrics } = req.body;

      if (!businessId) {
        return res.status(400).json({ error: "Missing required parameter: businessId" });
      }

      const result = await SessionStateModel.saveRaw(
        businessId,
        status || "completed",
        strategicAnswers || [],
        financialMetrics || []
      );

      return res.status(200).json({
        message: "Document Intelligence Session saved successfully directly to MongoDB.",
        result: result
      });
    } catch (error) {
      console.error("Error in SessionStateController.saveRaw:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  }

  // GET /api/sessions/business/:businessId
  static async getSession(req, res) {
    try {
      const { businessId } = req.params;
      
      if (!businessId) {
        return res.status(400).json({ error: "Missing required businessId" });
      }

      const session = await SessionStateModel.findByBusinessId(businessId);
      
      if (!session) {
        return res.status(444).json({ message: "No active session found for this business ID" });
      }

      return res.status(200).json(session);
    } catch (error) {
      console.error("Error in SessionStateController.getSession:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  }
}

module.exports = SessionStateController;
