const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const DecisionLogController = require("../controllers/decisionLogController");

// Cross-project feed — must come before /:projectId/* to avoid conflict
router.get("/", authenticateToken, DecisionLogController.getAllDecisionLogs);

// Business-level decision logs — must come before /:projectId/* to avoid conflict
router.get("/business/:businessId/filters", authenticateToken, DecisionLogController.getBusinessFilterOptions);
router.get("/business/:businessId", authenticateToken, DecisionLogController.getBusinessDecisionLogs);

router.post("/:projectId/logs", authenticateToken, DecisionLogController.createDecisionLog);
router.get("/:projectId/logs", authenticateToken, DecisionLogController.getProjectDecisionLogs);
router.get("/:projectId/timeline", authenticateToken, DecisionLogController.getDecisionTimeline);
router.get("/:decisionLogId/details", authenticateToken, DecisionLogController.getDecisionDetails);
router.patch("/:decisionLogId", authenticateToken, DecisionLogController.updateDecisionStatus);

module.exports = router;
