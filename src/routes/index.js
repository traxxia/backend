const express = require("express");
const router = express.Router();

const authRoutes = require("./authRoutes");
const companyRoutes = require("./companyRoutes");
const businessRoutes = require("./businessRoutes");
const questionRoutes = require("./questionRoutes");
const conversationRoutes = require("./conversationRoutes");
const documentRoutes = require("./documentRoutes");
const adminRoutes = require("./adminRoutes");
const initiativeRoutes = require("./initiativeRoutes");
const projectRoutes = require("./projectRoutes");
const projectFieldLockRoutes = require("./projectFieldLockRoutes");
const analysisRoutes = require("./analysisRoutes");
const planRoutes = require("./planRoutes");
const subscriptionRoutes = require("./subscriptionRoutes");

router.use("/api", authRoutes);
router.use("/api/plans", planRoutes);
router.use("/api/companies", companyRoutes);

router.use("/api/businesses", businessRoutes);
// Alias singular path to the same business routes to support
// clients calling /api/business/... as well as /api/businesses/...
router.use("/api/business", businessRoutes);
router.use("/api/questions", questionRoutes);
router.use("/api/conversations", conversationRoutes);
router.use("/api/businesses", documentRoutes);
router.use("/api/admin", adminRoutes);
router.use("/api/initiatives", initiativeRoutes);
router.use("/api/projects", projectRoutes);
router.use("/api/project-field-locks", projectFieldLockRoutes);
router.use("/api/analysis", analysisRoutes);
router.use("/api/subscription", subscriptionRoutes);

module.exports = router;
