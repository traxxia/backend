const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/projectController");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

router.get("/", authenticateToken, ProjectController.getAll);
router.post("/", authenticateToken, ProjectController.create);

router.put("/rank", authenticateToken, ProjectController.rankProjects);
router.get("/rank/:user_id", authenticateToken, ProjectController.getRankings);
router.get("/admin-rank", authenticateToken, ProjectController.getAdminRankings);
router.post("/lock-rank", authenticateToken, ProjectController.lockRank);

router.get("/check-access", authenticateToken, ProjectController.checkUserAccess);
router.get("/granted-access", authenticateToken, ProjectController.getGrantedAccess);
router.post("/revoke-access", authenticateToken, ProjectController.revokeAccess);

router.get("/:id", authenticateToken, ProjectController.getById);
router.patch("/:id", authenticateToken, ProjectController.update);
router.patch("/:id/status", authenticateToken, ProjectController.changeStatus);
router.put("/edit-access", authenticateToken, ProjectController.grantEditAccess);

router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  ProjectController.delete
);

module.exports = router;