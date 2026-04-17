const PlanModel = require('../models/planModel');
const StripeService = require('../services/stripeService');
const { logAuditEvent } = require('../services/auditService');

class PlanController {
    static async getAll(req, res) {
        try {
            const userRole = req.user?.role?.role_name || req.user?.role;
            const includeInactive = 
                req.query.include_inactive === 'true' || 
                req.headers['x-include-inactive'] === 'true' ||
                userRole === 'super_admin';

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

            if (planData.name !== undefined) {
                const name = (planData.name || '').trim();
                if (!name || !/[a-zA-Z]/.test(name)) {
                    return res.status(400).json({ error: 'Plan name must contain at least one letter' });
                }
                
                // Only check for existing plan on creation if name is provided
                const existingPlan = await PlanModel.findByName(name);
                if (existingPlan) {
                    return res.status(400).json({ error: 'Plan with this name already exists' });
                }
            } else {
                return res.status(400).json({ error: 'Plan name is required' });
            }

            if (!planData.period || !['month', 'year'].includes(planData.period)) {
                return res.status(400).json({ error: 'Valid billing period (month/year) is required' });
            }

            if (!planData.description || !planData.description.trim()) {
                return res.status(400).json({ error: 'Plan description is required' });
            }

            if (!/[a-zA-Z]/.test(planData.description)) {
                return res.status(400).json({ error: 'Plan description must contain at least one letter' });
            }

            // Stricter price validation using regex
            const priceStr = (planData.price !== undefined && planData.price !== null) ? planData.price.toString().trim() : '';
            if (!priceStr || !/^\d+(\.\d{1,2})?$/.test(priceStr)) {
                return res.status(400).json({ error: 'Valid non-negative price is required (e.g. 10.99)' });
            }

            // Validate limits
            if (planData.limits) {
                const { workspaces, collaborators, viewers, users } = planData.limits;
                if ((workspaces !== undefined && (isNaN(Number(workspaces)) || Number(workspaces) < 0)) ||
                    (collaborators !== undefined && (isNaN(Number(collaborators)) || Number(collaborators) < 0)) ||
                    (viewers !== undefined && (isNaN(Number(viewers)) || Number(viewers) < 0)) ||
                    (users !== undefined && (isNaN(Number(users)) || Number(users) < 0))) {
                    return res.status(400).json({ error: 'Plan limits must be non-negative numbers' });
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

            if (planData.period !== undefined && !['month', 'year'].includes(planData.period)) {
                return res.status(400).json({ error: 'Invalid billing period' });
            }

            if (planData.description !== undefined) {
                const desc = (planData.description || '').trim();
                if (!desc) {
                    return res.status(400).json({ error: 'Plan description cannot be empty' });
                }
                if (!/[a-zA-Z]/.test(desc)) {
                    return res.status(400).json({ error: 'Plan description must contain at least one letter' });
                }
            }

            if (planData.price !== undefined && planData.price !== null) {
                const priceStr = planData.price.toString().trim();
                if (!/^\d+(\.\d{1,2})?$/.test(priceStr)) {
                    return res.status(400).json({ error: 'Price must be a valid non-negative number' });
                }
            }

            // Validate limits
            if (planData.limits) {
                const { workspaces, collaborators, viewers, users } = planData.limits;
                if ((workspaces !== undefined && workspaces !== null && (isNaN(Number(workspaces)) || Number(workspaces) < 0)) ||
                    (collaborators !== undefined && collaborators !== null && (isNaN(Number(collaborators)) || Number(collaborators) < 0)) ||
                    (viewers !== undefined && viewers !== null && (isNaN(Number(viewers)) || Number(viewers) < 0)) ||
                    (users !== undefined && users !== null && (isNaN(Number(users)) || Number(users) < 0))) {
                    return res.status(400).json({ error: 'Plan limits must be non-negative numbers' });
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
