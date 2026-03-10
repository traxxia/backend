const PlanModel = require('../models/planModel');
const StripeService = require('../services/stripeService');
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

    static async create(req, res) {
        try {
            const planData = req.body;
            const userRole = req.user?.role?.role_name || req.user?.role;
            if (userRole !== 'admin' && userRole !== 'super_admin') {
                return res.status(403).json({ error: 'Access denied. Admin or Super Admin only.' });
            }

            if (planData.name) {
                const existingPlan = await PlanModel.findByName(planData.name);
                if (existingPlan) {
                    return res.status(400).json({ error: 'Plan with this name already exists' });
                }
            }

            // Create Stripe product and price if stripe_price_id is not already provided
            let stripePriceId = planData.stripe_price_id;
            if (!stripePriceId && planData.price !== undefined) {
                stripePriceId = await StripeService.createProductAndPrice(
                    planData.name,
                    planData.description || `Plan ${planData.name}`,
                    planData.price
                );
                planData.stripe_price_id = stripePriceId;
            }

            const planId = await PlanModel.create(planData);
            res.status(201).json({ message: 'Plan created successfully', planId, stripe_price_id: stripePriceId });
        } catch (error) {
            console.error('Failed to create plan:', error);
            res.status(500).json({ error: 'Failed to create plan' });
        }
    }

    static async update(req, res) {
        try {
            const planId = req.params.id;
            const planData = req.body;

            const userRole = req.user?.role?.role_name || req.user?.role;
            if (userRole !== 'admin' && userRole !== 'super_admin') {
                return res.status(403).json({ error: 'Access denied. Admin or Super Admin only.' });
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
