const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const companyRoutes = require('./companyRoutes');
const businessRoutes = require('./businessRoutes');
const questionRoutes = require('./questionRoutes');
const conversationRoutes = require('./conversationRoutes');
const documentRoutes = require('./documentRoutes');
const adminRoutes = require('./adminRoutes');

router.use('/api', authRoutes);
router.use('/api/companies', companyRoutes);
router.use('/api/businesses', businessRoutes);
router.use('/api/questions', questionRoutes);
router.use('/api/conversations', conversationRoutes);
router.use('/api/businesses', documentRoutes);
router.use('/api/admin', adminRoutes);

module.exports = router;