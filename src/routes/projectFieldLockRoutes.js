const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const ProjectFieldLockController = require("../controllers/projectFieldLockController");

router.post(
  "/:project_id/lock",
  authenticateToken,
  ProjectFieldLockController.lock
);

router.patch(
  "/:project_id/lock/heartbeat",
  authenticateToken,
  ProjectFieldLockController.heartbeat
);

router.delete(
  "/:project_id/lock",
  authenticateToken,
  ProjectFieldLockController.unlock
);

router.get(
  "/:project_id/lock",
  authenticateToken,
  ProjectFieldLockController.getLocks
);

module.exports = router;
