const express = require('express');
const router = express.Router();
const BusinessController = require('../controllers/businessController');
const { authenticateToken } = require('../middleware/auth');

router.get('/', authenticateToken, BusinessController.getAll);
router.post('/', authenticateToken, BusinessController.create);
router.delete('/:id', authenticateToken, BusinessController.delete);

module.exports = router;