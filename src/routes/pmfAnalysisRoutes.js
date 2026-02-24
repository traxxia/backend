const express = require("express");
const router = express.Router();
const PMFAnalysisController = require("../controllers/pmfAnalysisController");
const { authenticateToken } = require("../middleware/auth");

router.post("/onboarding", authenticateToken, PMFAnalysisController.saveOnboardingData);
router.get("/:businessId", authenticateToken, PMFAnalysisController.getPMFAnalysis);
router.post("/:businessId/insights", authenticateToken, PMFAnalysisController.saveInsights);
router.post("/:businessId/executive-summary", authenticateToken, PMFAnalysisController.saveExecutiveSummary);
router.get("/:businessId/executive-summary", authenticateToken, PMFAnalysisController.getExecutiveSummary);

module.exports = router;
