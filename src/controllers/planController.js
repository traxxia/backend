const PlanModel = require('../models/planModel');

class PlanController {
    static async getAll(req, res) {
        try {
            const plans = await PlanModel.getAll();
            res.json({ plans });
        } catch (error) {
            console.error('Failed to fetch plans:', error);
            res.status(500).json({ error: 'Failed to fetch plans' });
        }
    }

    static async getById(req, res) {
        try {
            const plan = await PlanModel.findById(req.params.id);
            if (!plan) {
                return res.status(404).json({ error: 'Plan not found' });
            }
            res.json({ plan });
        } catch (error) {
            console.error('Failed to fetch plan:', error);
            res.status(500).json({ error: 'Failed to fetch plan' });
        }
    }

    static async update(req, res) {
        try {
            const planId = req.params.id;
            const planData = req.body;

            if (req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Access denied. Admin only.' });
            }

            const result = await PlanModel.update(planId, planData);

            if (result.matchedCount === 0) {
                return res.status(404).json({ error: 'Plan not found' });
            }

            res.json({ message: 'Plan updated successfully' });
        } catch (error) {
            console.error('Failed to update plan:', error);
            res.status(500).json({ error: 'Failed to update plan' });
        }
    }
}

module.exports = PlanController;
