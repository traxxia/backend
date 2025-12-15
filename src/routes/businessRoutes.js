const express = require("express");
const router = express.Router();
const BusinessController = require("../controllers/businessController");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

router.get("/", authenticateToken, BusinessController.getAll);
router.post("/", authenticateToken, BusinessController.create);
router.delete("/:id", authenticateToken, BusinessController.delete);

// collaborator routes
router.post(
  "/:id/collaborators",
  authenticateToken,
  BusinessController.assignCollaborator
);
router.delete(
  "/:id/collaborators/:collabId",
  authenticateToken,
  BusinessController.removeCollaborator
);

// Business and Project Status change route
router.patch("/:id/status", authenticateToken, BusinessController.changeStatus);

module.exports = router;
