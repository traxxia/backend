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

            // Capture old plan to check for status transitions
            const oldPlan = await PlanModel.findById(planId);
            if (!oldPlan) {
                return res.status(404).json({ error: 'Plan not found' });
            }

            const result = await PlanModel.update(planId, planData);

            // Handle Stripe cancel_at_period_end toggling
            if (planData.status && planData.status !== oldPlan.status) {
                const db = require('../config/database').getDB();
                const { ObjectId } = require('mongodb');
                
                // Find all active companies on this plan
                const companies = await db.collection('companies').find({
                    plan_id: new ObjectId(planId),
                    stripe_subscription_id: { $ne: null },
                    subscription_status: { $in: ['active', 'past_due', 'trialing'] }
                }).toArray();

                for (const company of companies) {
                    try {
                        if (planData.status === 'disable') {
                            console.log(`[Plan Controller] Canceling Stripe auto-renewal for company ${company.company_name} because plan was disabled.`);
                            await StripeService.updateSubscription(company.stripe_subscription_id, {
                                cancel_at_period_end: true
                            });
                        } else if (planData.status === 'active') {
                            console.log(`[Plan Controller] Restoring Stripe auto-renewal for company ${company.company_name} because plan was re-enabled.`);
                            await StripeService.updateSubscription(company.stripe_subscription_id, {
                                cancel_at_period_end: false
                            });
                        }
                    } catch (stripeError) {
                        console.error(`Failed to update cancel_at_period_end for company ${company._id}:`, stripeError.message);
                    }
                }
            }

            res.json({ message: 'Plan updated successfully' });
        } catch (error) {
            console.error('Failed to update plan:', error);
            res.status(500).json({ error: 'Failed to update plan' });
        }
    }
}

module.exports = PlanController;
