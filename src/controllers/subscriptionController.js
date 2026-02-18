const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const TierService = require('../services/tierService');
const StripeService = require('../services/stripeService');
const { TIER_LIMITS } = require('../config/constants');

class SubscriptionController {
    static async getDetails(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user || !user.company_id) {
                return res.json({
                    plan: 'essential',
                    start_date: user?.created_at || new Date(),
                    end_date: null,
                    expires_at: null,
                    status: 'active',
                    available_plans: [],
                    billing_history: []
                });
            }

            const company = await db.collection('companies').findOne({ _id: user.company_id });
            const planName = await TierService.getUserTier(userId);
            const limits = TierService.getTierLimits(planName);

            // 1. Count Businesses
            const currentWorkspaces = await db.collection('user_businesses').countDocuments({
                user_id: new ObjectId(userId),
                status: { $ne: 'deleted' }
            });

            // 2. Count Collaborators
            const collabRole = await db.collection('roles').findOne({ role_name: 'collaborator' });
            const currentCollaborators = await db.collection('users').countDocuments({
                company_id: user.company_id,
                role_id: collabRole?._id
            });

            // 3. Count Projects
            const userBusinesses = await db.collection('user_businesses')
                .find({ user_id: new ObjectId(userId) })
                .project({ _id: 1 })
                .toArray();
            const businessIds = userBusinesses.map(b => b._id);
            const currentProjects = await db.collection('projects').countDocuments({
                business_id: { $in: businessIds }
            });

            // Available Plans
            const availablePlans = await db.collection('plans').find({ status: 'active' }).toArray();

            // Billing History
            const billingHistory = await db.collection('billing_history')
                .find({ company_id: user.company_id })
                .sort({ date: -1 })
                .toArray();

            // Expiration Logic
            let expiresAt = company?.expires_at;
            let status = company?.status || 'active';

            // If no expiration date (legacy data), set one based on created_at or give 30 days grace from now
            if (!expiresAt) {
                const baseDate = company?.created_at || user.created_at || new Date();
                expiresAt = new Date(baseDate);
                expiresAt.setMonth(expiresAt.getMonth() + 1);
            }

            // Check if expired
            if (new Date() > new Date(expiresAt) && status !== 'expired') {
                status = 'expired';
                // Update specific company status to expired
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { status: 'expired' } }
                );
            }

            const startDate = company?.created_at || user.created_at || new Date();

            // Fetch Payment Method Details if available
            let paymentMethodDetails = null;
            if (company?.stripe_payment_method_id) {
                try {
                    const pm = await StripeService.retrievePaymentMethod(company.stripe_payment_method_id);
                    if (pm && pm.card) {
                        paymentMethodDetails = {
                            brand: pm.card.brand,
                            last4: pm.card.last4
                        };
                    }
                } catch (stripeError) {
                    console.error('Failed to retrieve payment method:', stripeError);
                    // Continue without payment details
                }
            }

            res.json({
                plan: planName,
                company_name: company?.company_name,
                start_date: startDate,
                end_date: expiresAt,
                expires_at: expiresAt,
                status: status,
                payment_method: paymentMethodDetails,
                available_plans: availablePlans.map(p => ({
                    _id: p._id,
                    name: p.name,
                    price: p.price_usd || TIER_LIMITS[p.name.toLowerCase()]?.price_usd || 0,
                    features: p.features || []
                })),
                billing_history: billingHistory.map(bh => ({
                    date: bh.date,
                    plan_name: bh.plan_name,
                    amount: bh.amount
                })),
                usage: {
                    workspaces: {
                        current: currentWorkspaces,
                        limit: limits.max_workspaces
                    },
                    collaborators: {
                        current: currentCollaborators,
                        limit: limits.max_collaborators
                    },
                    projects: {
                        current: currentProjects,
                        limit: limits.can_create_projects ? (limits.max_projects || 'unlimited') : 0
                    }
                }
            });
        } catch (error) {
            console.error('Failed to fetch subscription details:', error);
            res.status(500).json({ error: 'Failed to fetch subscription details' });
        }
    }

    static async upgrade(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;
            const { plan_id } = req.body;

            if (!plan_id) {
                return res.status(400).json({ error: 'plan_id is required' });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user || !user.company_id) {
                return res.status(404).json({ error: 'User or company not found' });
            }

            const company = await db.collection('companies').findOne({ _id: user.company_id });
            const currentPlan = await db.collection('plans').findOne({ _id: company?.plan_id });
            const newPlan = await db.collection('plans').findOne({ _id: new ObjectId(plan_id) });

            if (!newPlan) {
                return res.status(404).json({ error: 'Selected plan not found' });
            }

            // Detect downgrade from Advanced to Essential
            const isDowngrade = (
                currentPlan?.name?.toLowerCase() === 'advanced' &&
                newPlan.name.toLowerCase() === 'essential'
            );

            if (isDowngrade) {
                // Check if user has multiple workspaces
                const workspaceCount = await db.collection('user_businesses').countDocuments({
                    user_id: new ObjectId(userId),
                    status: { $ne: 'deleted' }
                });

                // Get all businesses to check for collaborators
                const businesses = await db.collection('user_businesses')
                    .find({
                        user_id: new ObjectId(userId),
                        status: { $ne: 'deleted' }
                    })
                    .toArray();

                const hasCollaborators = businesses.some(b =>
                    b.collaborators && b.collaborators.length > 0
                );

                if (workspaceCount > 1 || hasCollaborators) {
                    // Fetch collaborator emails for better UI
                    const allCollabIds = businesses.reduce((acc, b) => {
                        if (b.collaborators) acc.push(...b.collaborators);
                        return acc;
                    }, []);

                    const uniqueCollabIds = [...new Set(allCollabIds.map(id => id.toString()))];
                    const collabsInfo = await db.collection('users').find(
                        { _id: { $in: uniqueCollabIds.map(id => new ObjectId(id)) } },
                        { projection: { _id: 1, email: 1 } }
                    ).toArray();

                    const collabMap = collabsInfo.reduce((acc, u) => {
                        acc[u._id.toString()] = u.email;
                        return acc;
                    }, {});

                    return res.status(200).json({
                        requires_selection: true,
                        action: 'downgrade',
                        current_plan: currentPlan?.name || 'unknown',
                        new_plan: newPlan.name,
                        workspace_count: workspaceCount,
                        has_collaborators: hasCollaborators,
                        businesses: businesses.map(b => ({
                            _id: b._id,
                            business_name: b.business_name,
                            collaborator_count: b.collaborators?.length || 0,
                            collaborators: (b.collaborators || []).map(id => ({
                                user_id: id,
                                email: collabMap[id.toString()] || 'Collaborator'
                            }))
                        })),
                        message: 'Please select which workspace to keep active and which collaborators to retain'
                    });
                }
            }

            // 5. Detect if reactivation selection is required (Moving to Advanced)
            const isReactivationPossible = (
                newPlan.name.toLowerCase() === 'advanced' &&
                (currentPlan?.name?.toLowerCase() === 'essential' || !currentPlan)
            );

            if (isReactivationPossible) {
                // Find all users in this company to get their businesses
                const companyUsers = await db.collection('users')
                    .find({ company_id: user.company_id })
                    .project({ _id: 1 })
                    .toArray();
                const companyUserIds = companyUsers.map(u => u._id);

                const archivedBusinesses = await db.collection('user_businesses')
                    .find({
                        user_id: { $in: companyUserIds },
                        access_mode: 'archived'
                    })
                    .toArray();

                const collabRole = await db.collection('roles').findOne({ role_name: 'collaborator' });
                const inactiveCollaborators = await db.collection('users')
                    .find({
                        company_id: user.company_id,
                        role_id: collabRole?._id,
                        status: 'inactive',
                        inactive_reason: 'plan_downgrade'
                    })
                    .toArray();

                if (archivedBusinesses.length > 0 || inactiveCollaborators.length > 0) {
                    return res.status(200).json({
                        requires_reactivation_selection: true,
                        action: 'upgrade_reactivation',
                        archived_businesses: archivedBusinesses.map(b => ({
                            _id: b._id.toString(),
                            business_name: b.business_name,
                            collaborators: b.collaborators?.map(id => id.toString()) || []
                        })),
                        inactive_collaborators: inactiveCollaborators.map(u => ({
                            _id: u._id.toString(),
                            email: u.email,
                            name: u.name,
                            // Find archived businesses this collaborator belongs to
                            associated_business_ids: archivedBusinesses
                                .filter(b => b.collaborators?.some(cid => cid.toString() === u._id.toString()))
                                .map(b => b._id.toString())
                        })),
                        limits: TIER_LIMITS.advanced,
                        plan_id: plan_id
                    });
                }
            }

            // Normal upgrade/downgrade (no selection needed)
            const now = new Date();
            const expiresAt = new Date(now);
            expiresAt.setMonth(expiresAt.getMonth() + 1);

            const result = await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        updated_at: now,
                        expires_at: expiresAt,
                        status: 'active' // Reactivate if expired
                    }
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({ error: 'Company not found' });
            }

            // Record in billing history
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: newPlan.price_usd || TIER_LIMITS[newPlan.name.toLowerCase()]?.price_usd || 0,
                date: new Date(),
                type: 'upgrade'
            });

            // Return updated details
            return SubscriptionController.getDetails(req, res);
        } catch (error) {
            console.error('Failed to upgrade plan:', error);
            res.status(500).json({ error: 'Failed to upgrade plan' });
        }
    }

    static async processDowngrade(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;
            const {
                plan_id,
                active_business_id,
                active_collaborator_ids = []
            } = req.body;

            if (!plan_id || !active_business_id) {
                return res.status(400).json({
                    error: 'plan_id and active_business_id are required'
                });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user || !user.company_id) {
                return res.status(404).json({ error: 'User or company not found' });
            }

            const company = await db.collection('companies').findOne({ _id: user.company_id });
            const currentPlan = await db.collection('plans').findOne({ _id: company?.plan_id });
            const newPlan = await db.collection('plans').findOne({ _id: new ObjectId(plan_id) });

            // 1. Get all user's businesses
            const allBusinesses = await db.collection('user_businesses').find({
                user_id: new ObjectId(userId),
                status: { $ne: 'deleted' }
            }).toArray();

            // Validate that active_business_id belongs to user
            const selectedBusiness = allBusinesses.find(b => b._id.toString() === active_business_id);
            if (!selectedBusiness) {
                return res.status(400).json({
                    error: 'Selected business not found or does not belong to you'
                });
            }

            // 2. Archive non-selected businesses (set access_mode to 'archived')
            const businessesToArchive = allBusinesses
                .filter(b => b._id.toString() !== active_business_id)
                .map(b => b._id);

            if (businessesToArchive.length > 0) {
                await db.collection('user_businesses').updateMany(
                    { _id: { $in: businessesToArchive } },
                    {
                        $set: {
                            access_mode: 'archived',
                            archived_at: new Date(),
                            archived_reason: 'plan_downgrade'
                        }
                    }
                );
            }

            // 3. Set active business to 'active' mode
            await db.collection('user_businesses').updateOne(
                { _id: new ObjectId(active_business_id) },
                { $set: { access_mode: 'active' } }
            );

            // 4. Archive ALL collaborator access for current company if downgrading to essential
            // In essential plan, collaborators are not allowed.
            if (newPlan.name.toLowerCase() === 'essential') {
                const collabRole = await db.collection('roles').findOne({ role_name: 'collaborator' });
                const collabsToArchive = await db.collection('users').find({
                    company_id: user.company_id,
                    role_id: collabRole?._id
                }).toArray();

                var archivedCollabCount = collabsToArchive.length;

                await db.collection('users').updateMany(
                    {
                        company_id: user.company_id,
                        role_id: collabRole?._id
                    },
                    {
                        $set: {
                            status: 'inactive',
                            access_mode: 'archived',
                            inactive_reason: 'plan_downgrade',
                            inactive_at: new Date()
                        }
                    }
                );

                // Also clear collaborators array from the active business
                await db.collection('user_businesses').updateOne(
                    { _id: new ObjectId(active_business_id) },
                    {
                        $set: {
                            collaborators: [],
                            archived_collaborators: selectedBusiness.collaborators || []
                        }
                    }
                );
            } else {
                // Handle non-essential downgrades if any (currently only Essential and Advanced exist)
                // For now, if it's not essential, we follow the previous logic or keep it as is.
                // But the request specifically mentioned essential and collaborators.
            }

            // 5. Lock all projects in archived businesses to read-only
            if (businessesToArchive.length > 0) {
                await db.collection('projects').updateMany(
                    { business_id: { $in: businessesToArchive } },
                    {
                        $set: {
                            is_readonly: true,
                            locked_at: new Date(),
                            lock_reason: 'business_archived'
                        }
                    }
                );
            }

            // 6. Update company plan
            const now = new Date();
            const expiresAt = new Date(now);
            expiresAt.setMonth(expiresAt.getMonth() + 1);

            await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        updated_at: now,
                        expires_at: expiresAt,
                        status: 'active'
                    }
                }
            );

            // Record in billing history
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: newPlan.price_usd || TIER_LIMITS[newPlan.name.toLowerCase()]?.price_usd || 0,
                date: new Date(),
                type: 'downgrade'
            });

            // 7. Audit log
            const { logAuditEvent } = require('../services/auditService');
            await logAuditEvent(userId, 'plan_downgraded', {
                from_plan: currentPlan?.name || 'unknown',
                to_plan: newPlan.name,
                active_business_id,
                archived_businesses: businessesToArchive.length,
                active_collaborators: (active_collaborator_ids || []).length,
                archived_collaborators: typeof archivedCollabCount !== 'undefined' ? archivedCollabCount : 0
            });

            // 8. Return updated details
            return SubscriptionController.getDetails(req, res);

        } catch (error) {
            console.error('Downgrade processing error:', error);
            res.status(500).json({ error: 'Failed to process downgrade' });
        }
    }

    static async processReactivation(req, res) {
        try {
            const {
                plan_id,
                reactivate_business_ids = [],
                reactivate_collaborator_ids = []
            } = req.body;

            const db = getDB();
            const userId = req.user._id;
            console.log('DEBUG: processReactivation selection:', {
                plan_id,
                reactivate_business_ids,
                reactivate_collaborator_ids
            });
            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

            if (!user.company_id) {
                return res.status(403).json({ error: 'User not associated with a company' });
            }

            const newPlan = await db.collection('plans').findOne({ _id: new ObjectId(plan_id) });
            if (!newPlan) return res.status(404).json({ error: 'Plan not found' });


            const limits = TIER_LIMITS[newPlan.name.toLowerCase()] || TIER_LIMITS.essential;

            // 1. Validate limits
            const companyUsers = await db.collection('users')
                .find({ company_id: user.company_id })
                .project({ _id: 1 })
                .toArray();
            const companyUserIds = companyUsers.map(u => u._id);

            const activeBusinessesCount = await db.collection('user_businesses').countDocuments({
                user_id: { $in: companyUserIds },
                access_mode: 'active'
            });

            if (activeBusinessesCount + reactivate_business_ids.length > limits.max_workspaces) {
                return res.status(400).json({ error: `You can only have ${limits.max_workspaces} active workspaces.` });
            }

            // 2. Reactivate Businesses
            if (reactivate_business_ids.length > 0) {
                await db.collection('user_businesses').updateMany(
                    {
                        _id: { $in: reactivate_business_ids.map(id => new ObjectId(id)) }
                    },
                    { $set: { access_mode: 'active', updated_at: new Date() } }
                );

                // Unlock projects in these businesses
                await db.collection('projects').updateMany(
                    { business_id: { $in: reactivate_business_ids.map(id => new ObjectId(id)) } },
                    {
                        $set: {
                            is_readonly: false,
                            updated_at: new Date()
                        },
                        $unset: {
                            locked_at: "",
                            lock_reason: ""
                        }
                    }
                );
            }

            // 3. Reactivate Collaborators
            if (reactivate_collaborator_ids.length > 0) {
                await db.collection('users').updateMany(
                    {
                        _id: { $in: reactivate_collaborator_ids.map(id => new ObjectId(id)) },
                        company_id: user.company_id
                    },
                    {
                        $set: {
                            status: 'active',
                            access_mode: 'active',
                            updated_at: new Date()
                        },
                        $unset: {
                            inactive_reason: "",
                            inactive_at: ""
                        }
                    }
                );
            }

            // 4. Finally update the plan
            const now = new Date();
            const expiresAt = new Date(now);
            expiresAt.setMonth(expiresAt.getMonth() + 1);

            await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        updatedAt: now,
                        expires_at: expiresAt,
                        status: 'active'
                    }
                }
            );

            // Record in billing history
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: newPlan.price_usd || TIER_LIMITS[newPlan.name.toLowerCase()]?.price_usd || 0,
                date: new Date(),
                type: 'reactivation'
            });

            // Return updated details
            return SubscriptionController.getDetails(req, res);

        } catch (error) {
            console.error('Reactivation error:', error);
            res.status(500).json({ error: error.message });
        }
    }
}

module.exports = SubscriptionController;
