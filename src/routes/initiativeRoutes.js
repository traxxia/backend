const express = require("express");
const router = express.Router();
const InitiativeController = require("../controllers/initiativeController");
const { authenticateToken, requireSuperAdmin } = require("../middleware/auth");

router.get("/", authenticateToken, InitiativeController.getAll);
router.get("/:id", authenticateToken, InitiativeController.getById);
router.post("/", authenticateToken, InitiativeController.create);
router.patch("/:id", authenticateToken, InitiativeController.update);
router.delete("/:id", authenticateToken, InitiativeController.delete);
module.exports = router;
