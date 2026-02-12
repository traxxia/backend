const express = require('express');
const router = express.Router();
const PlanController = require('../controllers/planController');
const { authenticateToken } = require('../middleware/auth');

router.get('/', PlanController.getAll);

router.get('/:id', authenticateToken, PlanController.getById);
router.put('/:id', authenticateToken, PlanController.update);

module.exports = router;
