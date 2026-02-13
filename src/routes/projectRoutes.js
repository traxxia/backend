const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/projectController");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { checkWriteAccess, checkProjectCreation } = require("../middleware/subscriptionMiddleware");

router.get("/", authenticateToken, ProjectController.getAll);
router.post("/", authenticateToken, checkProjectCreation, ProjectController.create);

router.put("/rank", authenticateToken, ProjectController.rankProjects);
router.post("/launch", authenticateToken, requireAdmin, ProjectController.launchProjects);
router.get("/rank/:user_id", authenticateToken, ProjectController.getRankings);
router.get("/admin-rank", authenticateToken, ProjectController.getAdminRankings);
router.post("/lock-rank", authenticateToken, ProjectController.lockRank);

router.get("/check-access", authenticateToken, ProjectController.checkUserAccess);
router.get("/granted-access", authenticateToken, ProjectController.getGrantedAccess);
router.post("/revoke-access", authenticateToken, ProjectController.revokeAccess);

// AI Ranking routes - FIXED: Use authenticateToken instead of authenticate
router.post("/ai-rankings",
  authenticateToken,
  ProjectController.saveAIRankings
);

router.get("/ai-rankings",
  authenticateToken,
  ProjectController.getAIRankings
);
router.get("/consensus-analysis", authenticateToken, ProjectController.getConsensusAnalysis);
router.get("/collaborator-consensus", authenticateToken, ProjectController.getCollaboratorConsensus);
// Project-specific routes (keep these AFTER the more specific routes above)
router.get("/:id", authenticateToken, ProjectController.getById);
router.patch("/:id", authenticateToken, checkWriteAccess, ProjectController.update);
router.patch("/:id/status", authenticateToken, checkWriteAccess, ProjectController.changeStatus);
router.put("/edit-access", authenticateToken, ProjectController.grantEditAccess);

router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  ProjectController.delete
);

module.exports = router;