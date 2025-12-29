const express = require("express");
const router = express.Router();
const BusinessController = require("../controllers/businessController");
const { authenticateToken, requireAdmin } = require("../middleware/auth");

router.get("/", authenticateToken, BusinessController.getAll);
router.post("/", authenticateToken, BusinessController.create);
router.delete("/:id", authenticateToken, BusinessController.delete);

// collaborator routes

router.get(
  "/:id/collaborators",
  authenticateToken,
  BusinessController.getCollaborators
);

router.patch('/:id/allowed-collaborators', authenticateToken, BusinessController.setAllowedCollaborators);

router.patch(
  "/:id/allowed-ranking-collaborators",
  authenticateToken,
  BusinessController.setAllowedRankingCollaborators
);


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
