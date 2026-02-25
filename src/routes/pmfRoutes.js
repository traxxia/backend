const express = require("express");
const router = express.Router();
const PMFController = require("../controllers/pmfController");
const { authenticateToken } = require("../middleware/auth");

router.get("/kickstart/:businessId", authenticateToken, PMFController.getKickstartData);
router.post("/kickstart", authenticateToken, PMFController.kickstartProject);

module.exports = router;
