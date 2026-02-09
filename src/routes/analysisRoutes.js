const express = require("express");
const router = express.Router();
const AnalysisController = require("../controllers/analysisController");

//Create new analysis
router.post("/", AnalysisController.create);

// Get analysis by business id
router.get("/business/:businessId", AnalysisController.getAll);

// Get analysis by phase
router.get("/business/:businessId/phase/:phase", AnalysisController.getByPhase);

// Get analysis by filter
router.get("/business/:businessId/filter", AnalysisController.getByFilter);

module.exports = router;
