const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/projectController");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

router.get("/", authenticateToken, ProjectController.getAll);
router.post("/", authenticateToken, ProjectController.create);

router.put("/rank", authenticateToken, ProjectController.rankProjects);
router.get("/rank/:user_id", authenticateToken, ProjectController.getRankings);
router.get("/admin-rank",authenticateToken,ProjectController.getAdminRankings);
router.post("/lock-rank",authenticateToken,ProjectController.lockRank);


router.get("/:id", authenticateToken, ProjectController.getById);
router.patch("/:id", authenticateToken, ProjectController.update);

router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  ProjectController.delete
);


module.exports = router;
