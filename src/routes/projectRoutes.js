const express = require("express");
const router = express.Router();
const ProjectController = require("../controllers/projectController");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

router.get("/", authenticateToken, ProjectController.getAll);
router.get("/:id", authenticateToken, ProjectController.getById);
router.post("/", authenticateToken, ProjectController.create);
router.patch("/:id", authenticateToken, ProjectController.update);
router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  ProjectController.delete
);

module.exports = router;
