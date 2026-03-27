const PlanModel = require('../models/planModel');
const StripeService = require('../services/stripeService');
const { logAuditEvent } = require('../services/auditService');

class PlanController {
    static async getAll(req, res) {
        try {
            const includeInactive = req.query.include_inactive === 'true' || req.headers['x-include-inactive'] === 'true';
            const plans = await PlanModel.getAll(includeInactive);
            
            // Sort by price ascending
            const sortedPlans = plans.map(p => ({
                ...p,
                price: p.price || 0
            })).sort((a, b) => a.price - b.price);

            res.json({ plans: sortedPlans });
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
            if (userRole !== 'super_admin') {
                return res.status(403).json({ error: 'Access denied. Super Admin only.' });
            }

            // Sanitize features if they exist
            if (planData.features && Array.isArray(planData.features)) {
                planData.features = planData.features
                    .map(f => typeof f === 'string' ? f.trim() : f)
                    .filter(f => f !== '');
            }

            if (planData.name) {
                const name = planData.name.trim();
                if (!name || !/[a-zA-Z]/.test(name)) {
                    return res.status(400).json({ error: 'Plan name must contain at least one letter' });
                }
                const existingPlan = await PlanModel.findByName(name);
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
                    planData.price,
                    planData.interval || planData.period || 'month'
                );
                planData.stripe_price_id = stripePriceId;
            }

            const planId = await PlanModel.create(planData);
            
            // Log audit event
            await logAuditEvent(req.user._id, 'plan_created', { 
                plan_name: planData.name, 
                plan_id: planId,
                price: planData.price 
            });

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
            if (userRole !== 'super_admin') {
                return res.status(403).json({ error: 'Access denied. Super Admin only.' });
            }

            // Sanitize features if they exist
            if (planData.features && Array.isArray(planData.features)) {
                planData.features = planData.features
                    .map(f => typeof f === 'string' ? f.trim() : f)
                    .filter(f => f !== '');
            }

            if (planData.name !== undefined) {
                const name = (planData.name || '').trim();
                if (!name || !/[a-zA-Z]/.test(name)) {
                    return res.status(400).json({ error: 'Plan name must contain at least one letter' });
                }
            }

            // Capture old plan to check for status transitions
            const oldPlan = await PlanModel.findById(planId);
            if (!oldPlan) {
                return res.status(404).json({ error: 'Plan not found' });
            }

            const result = await PlanModel.update(planId, planData);

            // Log audit event
            await logAuditEvent(req.user._id, 'plan_updated', { 
                plan_id: planId, 
                plan_name: oldPlan.name,
                changes: planData 
            });

            // Handle Stripe cancel_at_period_end toggling in the "background" (non-blocking)
            if (planData.status && planData.status !== oldPlan.status) {
                // Return response early to the user
                res.json({ message: 'Plan updated successfully. Stripe synchronization started in background.' });

                // Start background sync
                (async () => {
                    try {
                        const db = require('../config/database').getDB();
                        const { ObjectId } = require('mongodb');
                        
                        // Find all active companies on this plan
                        const companies = await db.collection('companies').find({
                            plan_id: new ObjectId(planId),
                            stripe_subscription_id: { $ne: null },
                            subscription_status: { $in: ['active', 'past_due', 'trialing'] }
                        }).toArray();

                        console.log(`[Plan Controller] Starting background Stripe sync for ${companies.length} companies on plan ${oldPlan.name}...`);

                        for (const company of companies) {
                            try {
                                const isDisabling = planData.status === 'disable' || planData.status === 'inactive';
                                
                                if (isDisabling) {
                                    console.log(`[Plan Controller] Canceling Stripe auto-renewal for company ${company.company_name} (${company._id})`);
                                    await StripeService.updateSubscription(company.stripe_subscription_id, {
                                        cancel_at_period_end: true
                                    });
                                } else if (planData.status === 'active') {
                                    console.log(`[Plan Controller] Restoring Stripe auto-renewal for company ${company.company_name} (${company._id})`);
                                    await StripeService.updateSubscription(company.stripe_subscription_id, {
                                        cancel_at_period_end: false
                                    });
                                }
                            } catch (stripeError) {
                                console.error(`[Plan Controller] Failed to update Stripe for company ${company._id}:`, stripeError.message);
                            }
                        }
                        console.log(`[Plan Controller] Background Stripe sync completed for plan ${oldPlan.name}.`);
                    } catch (bgError) {
                        console.error('[Plan Controller] Background Stripe sync failed:', bgError);
                    }
                })();
                
                return; // Prevent fallthrough to the second res.json
            }

            res.json({ message: 'Plan updated successfully' });
        } catch (error) {
            console.error('Failed to update plan:', error);
            res.status(500).json({ error: 'Failed to update plan' });
        }
    }
}

module.exports = PlanController;
