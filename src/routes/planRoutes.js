const express = require('express');
const router = express.Router();
const PlanController = require('../controllers/planController');
const { authenticateToken, requireSuperAdmin } = require('../middleware/auth');

router.get('/', PlanController.getAll);
router.post('/', authenticateToken, requireSuperAdmin, PlanController.create);

router.get('/:id', authenticateToken, PlanController.getById);
router.put('/:id', authenticateToken, requireSuperAdmin, PlanController.update);

module.exports = router;
