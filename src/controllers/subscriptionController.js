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
            // Use snapshotted limits so super-admin plan edits don't affect existing customers
            const limits = await TierService.getCompanyLimits(user.company_id);

            // 1. Count Businesses across whole company
            const companyUsers = await db.collection('users').find({ company_id: user.company_id }).project({ _id: 1 }).toArray();
            const companyUserIds = companyUsers.map(u => u._id);

            const currentWorkspaces = await db.collection('user_businesses').countDocuments({
                user_id: { $in: companyUserIds },
                status: 'active'
            });

            // 2. Count Collaborators
            const collabRole = await db.collection('roles').findOne({ role_name: 'collaborator' });
            const currentCollaborators = await db.collection('users').countDocuments({
                company_id: user.company_id,
                role_id: collabRole?._id,
                status: 'active'
            });

                        // 2b. Count Viewers
            const viewerRole = await db.collection('roles').findOne({ role_name: 'viewer' });
            const currentViewers = await db.collection('users').countDocuments({
                company_id: user.company_id,
                role_id: viewerRole?._id,
                status: 'active'
            });

            // 2c. Count Users (role 'user')
            const userRole = await db.collection('roles').findOne({ role_name: 'user' });
            const currentUsersWithUserRole = await db.collection('users').countDocuments({
                company_id: user.company_id,
                role_id: userRole?._id,
                status: 'active'
            });

            // 3. Count Projects across all company businesses
            const companyBusinesses = await db.collection('user_businesses')
                .find({ user_id: { $in: companyUserIds } })
                .project({ _id: 1 })
                .toArray();
            const businessIds = companyBusinesses.map(b => b._id);
            const currentProjects = await db.collection('projects').countDocuments({
                business_id: { $in: businessIds }
            });

            // Available Plans
            const availablePlans = await db.collection('plans').find({ status: 'active' }).sort({ _id: 1 }).toArray();

            // Billing History
            const billingHistory = await db.collection('billing_history')
                .find({ company_id: user.company_id })
                .sort({ date: -1 })
                .toArray();

            // Expiration Logic
            let expiresAt = company?.subscription_end_date || company?.expires_at;
            let startDate = company?.subscription_start_date || company?.created_at || user.created_at || new Date();
            let status = company?.subscription_status || company?.status || 'active';

            const isManualAccount = TierService.isStripeAccountNull(company || {});

            // If no expiration date (legacy data), set one based on created_at or give 30 days grace from now
            if (!expiresAt) {
                expiresAt = new Date(startDate);
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

            // If manual account and the DB says expired, force it back to active for the response.
            if (isManualAccount && status === 'expired') {
                status = 'active';
            }

            // Set expiresAt to null for unlimited accounts to signal frontend
            if (isManualAccount) {
                expiresAt = null;
            }

            // Fetch Payment Method Details if available
            let paymentMethods = [];
            let defaultPaymentMethodId = null;

            if (company?.stripe_customer_id) {
                try {
                    const methods = await StripeService.listPaymentMethods(company.stripe_customer_id);
                    paymentMethods = methods.map(pm => ({
                        id: pm.id,
                        brand: pm.card.brand,
                        last4: pm.card.last4,
                        exp_month: pm.card.exp_month,
                        exp_year: pm.card.exp_year
                    }));
                    defaultPaymentMethodId = company.stripe_payment_method_id;

                } catch (stripeError) {
                    console.error('Failed to retrieve payment methods:', stripeError);
                }
            }

            // Determine if the live plan limits differ from the customer's snapshot
            // so the frontend can show a "limits locked until renewal" notice.
            let planUpdatedSinceSnapshot = false;
            if (company?.plan_snapshot?.snapshotted_at) {
                const livePlan = await db.collection('plans').findOne({ _id: company.plan_id });
                if (livePlan) {
                    const liveLimits = TierService.getLimitsForPlan(livePlan);
                    const snap = company.plan_snapshot;
                    planUpdatedSinceSnapshot = (
                        liveLimits.max_workspaces    !== snap.max_workspaces    ||
                        liveLimits.max_collaborators !== snap.max_collaborators ||
                        liveLimits.max_viewers       !== snap.max_viewers       ||
                        liveLimits.max_users         !== snap.max_users         ||
                        liveLimits.project           !== snap.project           ||
                        liveLimits.insight           !== snap.insight           ||
                        liveLimits.strategic         !== snap.strategic         ||
                        liveLimits.pmf               !== snap.pmf
                    );
                }
            }

            res.json({
                plan: planName,
                plan_price: company?.subscription_plan_price || TIER_LIMITS[planName.toLowerCase()]?.price_usd || 0,
                plan_limits: limits,
                company_name: company?.company_name,
                start_date: startDate,
                end_date: expiresAt,
                expires_at: expiresAt,
                status: status,
                is_unlimited: isManualAccount,
                plan_updated_since_snapshot: planUpdatedSinceSnapshot,
                payment_methods: paymentMethods,
                default_payment_method_id: defaultPaymentMethodId,
                available_plans: availablePlans.map(p => {
                    const planLimits = TierService.getLimitsForPlan(p);
                    return {
                        _id: p._id,
                        name: p.name,
                        description: p.description || '',
                        price: p.price || TIER_LIMITS[p.name.toLowerCase()]?.price_usd || 0,
                        features: p.features || [],
                        limits: {
                            workspaces:    planLimits.max_workspaces,
                            collaborators: planLimits.max_collaborators,
                            viewers:       planLimits.max_viewers,
                            users:         planLimits.max_users,
                            project:       planLimits.project,
                            pmf:           planLimits.pmf,
                            insight:       planLimits.insight,
                            strategic:     planLimits.strategic
                        }
                    };
                }),
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
                    users: {
                        current: currentUsersWithUserRole,
                        limit: limits.max_users ?? 0
                    },
                    viewers: {
                        current: currentViewers,
                        limit: limits.max_viewers ?? 0
                    },
                    projects: {
                        current: currentProjects,
                        limit: limits.project
                    },
                    pmf:       limits.pmf      ?? false,
                    insight:   limits.insight  ?? false,
                    strategic: limits.strategic ?? false
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
            const { plan_id, paymentMethodId, saveCard } = req.body;

            if (!plan_id) {
                return res.status(400).json({ error: 'plan_id is required' });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user || !user.company_id) {
                return res.status(404).json({ error: 'User or company not found' });
            }

            const company = await db.collection('companies').findOne({ _id: user.company_id });

            // Handle Payment Method Update if provided
            if (paymentMethodId) {
                try {
                    let customerId = company.stripe_customer_id;
                    let shouldSetDefault = saveCard !== false;

                    if (customerId) {
                        // Check if already attached
                        const pm = await StripeService.retrievePaymentMethod(paymentMethodId);

                        if (pm.customer !== customerId) {
                            // Attach new payment method to existing customer
                            await StripeService.attachPaymentMethod(paymentMethodId, customerId);
                        }

                        // Set as default if requested
                        if (shouldSetDefault) {
                            await StripeService.updateCustomer(customerId, {
                                invoice_settings: { default_payment_method: paymentMethodId }
                            });
                            // Update local record
                            await db.collection('companies').updateOne(
                                { _id: user.company_id },
                                { $set: { stripe_payment_method_id: paymentMethodId } }
                            );
                        }
                    } else {
                        // Create new customer if missing
                        const customer = await StripeService.createCustomer(
                            user.email,
                            user.name,
                            paymentMethodId,
                            shouldSetDefault // Use the flag
                        );
                        customerId = customer.id;

                        // Update company with customer ID
                        await db.collection('companies').updateOne(
                            { _id: user.company_id },
                            { $set: { stripe_customer_id: customerId } }
                        );

                        if (shouldSetDefault) {
                            await db.collection('companies').updateOne(
                                { _id: user.company_id },
                                { $set: { stripe_payment_method_id: paymentMethodId } }
                            );
                        }
                    }

                } catch (stripeError) {
                    console.error('Stripe payment update failed:', stripeError);
                    return res.status(400).json({ error: 'Failed to update payment method: ' + stripeError.message });
                }
            }

            const currentPlan = await db.collection('plans').findOne({ _id: company?.plan_id });
            const newPlan = await db.collection('plans').findOne({ _id: new ObjectId(plan_id) });

            if (!newPlan) {
                return res.status(404).json({ error: 'Selected plan not found' });
            }

            const usage = await TierService.getCompanyUsage(user.company_id);
            const newLimits = TierService.getLimitsForPlan(newPlan);

            // Dynamically detect downgrade based on usage vs new limits
            const isDowngrade = (
                usage.workspaces > (newLimits.max_workspaces || 0) ||
                usage.collaborators > (newLimits.max_collaborators || 0) ||
                usage.viewers > (newLimits.max_viewers || 0) ||
                usage.users > (newLimits.max_users || 0)
            );

            if (isDowngrade) {
                // Check if company has multiple workspaces
                const companyUsers = await db.collection('users').find({ company_id: user.company_id }).project({ _id: 1 }).toArray();
                const companyUserIds = companyUsers.map(u => u._id);

                const workspaceCount = await db.collection('user_businesses').countDocuments({
                    user_id: { $in: companyUserIds },
                    status: { $ne: 'deleted' }
                });

                // Get all company businesses to check for collaborators
                const businesses = await db.collection('user_businesses')
                    .find({
                        user_id: { $in: companyUserIds },
                        status: { $ne: 'deleted' }
                    })
                    .toArray();

                const hasCollaborators = businesses.some(b =>
                    b.collaborators && b.collaborators.length > 0
                );

                if (isDowngrade) { // Enforce selection on any downgrade limits
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

            // 5. Detect if reactivation selection is required (if moving to a higher limit plan and having archived items)
            const currentLimits = await TierService.getCompanyLimits(user.company_id);
            const archivedUsage = await TierService.getCompanyArchivedUsage(user.company_id);
            const isReactivationPossible = (
                (newLimits.max_workspaces > (currentLimits.max_workspaces || 0) && archivedUsage.workspaces > 0) ||
                (newLimits.max_collaborators > (currentLimits.max_collaborators || 0) && archivedUsage.collaborators > 0) ||
                (newLimits.max_viewers > (currentLimits.max_viewers || 0) && archivedUsage.viewers > 0) ||
                (newLimits.max_users > (currentLimits.max_users || 0) && archivedUsage.users > 0)
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

                const activeBusinesses = await db.collection('user_businesses')
                    .find({
                        user_id: { $in: companyUserIds },
                        access_mode: 'active',
                        status: { $ne: 'deleted' }
                    })
                    .toArray();

                const roles = await db.collection('roles').find({}).toArray();
                const roleMap = roles.reduce((acc, r) => {
                    acc[r._id.toString()] = r.role_name;
                    return acc;
                }, {});

                const allInactiveUsers = await db.collection('users').find({
                    company_id: user.company_id,
                    status: 'inactive',
                    inactive_reason: 'plan_downgrade'
                }).toArray();

                const allActiveUsers = await db.collection('users').find({
                    company_id: user.company_id,
                    status: 'active'
                }).toArray();

                const inactive_collaborators = [];
                const inactive_users = [];
                const inactive_viewers = [];

                const active_collaborators = [];
                const active_users = [];
                const active_viewers = [];

                allInactiveUsers.forEach(u => {
                    const roleName = roleMap[u.role_id?.toString()];
                    const userData = {
                        _id: u._id.toString(),
                        email: u.email,
                        name: u.name,
                        associated_business_ids: archivedBusinesses
                            .filter(b => b.collaborators?.some(cid => cid.toString() === u._id.toString()))
                            .map(b => b._id.toString())
                    };

                    if (roleName === 'collaborator') inactive_collaborators.push(userData);
                    else if (roleName === 'user') inactive_users.push(userData);
                    else if (roleName === 'viewer') inactive_viewers.push(userData);
                });

                allActiveUsers.forEach(u => {
                    const roleName = roleMap[u.role_id?.toString()];
                    const userData = {
                        _id: u._id.toString(),
                        email: u.email,
                        name: u.name
                    };
                    if (roleName === 'collaborator') active_collaborators.push(userData);
                    else if (roleName === 'user') active_users.push(userData);
                    else if (roleName === 'viewer') active_viewers.push(userData);
                });

                if (archivedBusinesses.length > 0 || allInactiveUsers.length > 0) {
                    return res.status(200).json({
                        requires_reactivation_selection: true,
                        action: 'upgrade_reactivation',
                        archived_businesses: archivedBusinesses.map(b => ({
                            _id: b._id.toString(),
                            business_name: b.business_name,
                            collaborators: b.collaborators?.map(id => id.toString()) || []
                        })),
                        active_businesses: activeBusinesses.map(b => ({
                            _id: b._id.toString(),
                            business_name: b.business_name
                        })),
                        inactive_collaborators,
                        inactive_users,
                        inactive_viewers,
                        active_collaborators,
                        active_users,
                        active_viewers,
                        limits: newLimits,
                        new_plan_name: newPlan.name,
                        plan_id: plan_id
                    });
                }
            }

            // 6. Sync with Stripe
            let stripeSubscriptionId = company?.stripe_subscription_id;
            let periodStart = new Date();
            let periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            if (newPlan.stripe_price_id) {
                try {
                    if (stripeSubscriptionId) {
                        // Update existing subscription
                        console.log(`Updating Stripe subscription ${stripeSubscriptionId} to price ${newPlan.stripe_price_id}`);
                        const subscription = await StripeService.updateSubscription(stripeSubscriptionId, {
                            items: [{
                                id: (await StripeService.retrieveSubscription(stripeSubscriptionId)).items.data[0].id,
                                price: newPlan.stripe_price_id,
                            }],
                            proration_behavior: 'always_invoice',
                        });
                        if (subscription.current_period_start) periodStart = new Date(subscription.current_period_start * 1000);
                        if (subscription.current_period_end) periodEnd = new Date(subscription.current_period_end * 1000);
                    } else if (company?.stripe_customer_id) {
                        // Create new subscription
                        console.log(`Creating new Stripe subscription for customer ${company.stripe_customer_id} with price ${newPlan.stripe_price_id}`);
                        const subscription = await StripeService.createSubscription(
                            company.stripe_customer_id,
                            newPlan.stripe_price_id,
                            company.stripe_payment_method_id
                        );
                        stripeSubscriptionId = subscription.id;
                        if (subscription.current_period_start) periodStart = new Date(subscription.current_period_start * 1000);
                        if (subscription.current_period_end) periodEnd = new Date(subscription.current_period_end * 1000);
                    }
                } catch (stripeError) {
                    console.error('Stripe sync failed during upgrade:', stripeError);
                    // We continue for now to keep local DB updated, but ideally we should handle this
                }
            }

            // Normal upgrade/downgrade (no selection needed)
            // Snapshot current plan limits so existing customer is not affected by future plan edits
            const planSnapshot = TierService.buildPlanSnapshot(newPlan);
            const result = await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        subscription_plan: newPlan.name,
                        plan_snapshot: planSnapshot,
                        stripe_subscription_id: stripeSubscriptionId,
                        subscription_start_date: periodStart,
                        subscription_end_date: periodEnd,
                        expires_at: periodEnd,
                        updated_at: new Date(),
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
                amount: newPlan.price || newPlan.price_usd || TIER_LIMITS[newPlan.name.toLowerCase()]?.price_usd || 0,
                date: new Date(),
                type: 'upgrade',
                stripe_subscription_id: stripeSubscriptionId
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
                active_collaborator_ids = [],
                active_user_ids = [],
                active_viewer_ids = []
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

            // --- INSTANT RENEWAL TRIGGER ---
            // If the DB says the plan is expiring soon (or already expired), 
            // and we have a Stripe subscription, we force Stripe to renew NOW.
            if (company?.stripe_subscription_id && company.subscription_status === 'active') {
                const now = new Date();
                const expiry = company.subscription_end_date ? new Date(company.subscription_end_date) : null;

                // If expiry is missing, or in the past, or expires within 24 hours
                if (!expiry || expiry < new Date(now.getTime() + 24 * 60 * 60 * 1000)) {
                    try {
                        console.log(`Plan for ${company.company_name} is due. Triggering instant Stripe renewal...`);

                        // Tell Stripe to reset the billing cycle to "NOW"
                        // This forces an immediate invoice and payment attempt.
                        await StripeService.updateSubscription(company.stripe_subscription_id, {
                            billing_cycle_anchor: 'now',
                            proration_behavior: 'always_invoice'
                        });

                        console.log("Stripe renewal triggered successfully.");
                        // Note: The Webhook will handle updating the DB with the new dates shortly.
                    } catch (stripeError) {
                        console.error("Failed to trigger instant renewal:", stripeError.message);
                    }
                }
            }

            const currentPlan = await db.collection('plans').findOne({ _id: company?.plan_id });
            const newPlan = await db.collection('plans').findOne({ _id: new ObjectId(plan_id) });

            if (!newPlan) {
                return res.status(404).json({ error: 'New plan not found' });
            }

            const newLimits = newPlan.limits || {};

            // 1. Get all company's businesses
            const companyUsers = await db.collection('users').find({ company_id: user.company_id }).project({ _id: 1 }).toArray();
            const companyUserIds = companyUsers.map(u => u._id);

            const allBusinesses = await db.collection('user_businesses').find({
                user_id: { $in: companyUserIds },
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
                            status: 'archived',
                            archived_at: new Date(),
                            archived_reason: 'plan_downgrade'
                        }
                    }
                );
            }

            // 3. Set active business to 'active' mode
            await db.collection('user_businesses').updateOne(
                { _id: new ObjectId(active_business_id) },
                { $set: { access_mode: 'active', status: 'active' } }
            );

            // 4. Archive non-selected users (Collaborators, Viewers, and Users)
            const allSelectedUserIds = [
                ...active_collaborator_ids,
                ...active_user_ids,
                ...active_viewer_ids
            ].map(id => id.toString());

            const restrictedRoles = await db.collection('roles').find({
                role_name: { $in: ['collaborator', 'viewer', 'user'] }
            }).toArray();
            const restrictedRoleIds = restrictedRoles.map(r => r._id);

            await db.collection('users').updateMany(
                {
                    company_id: user.company_id,
                    role_id: { $in: restrictedRoleIds },
                    _id: { $nin: allSelectedUserIds.map(id => new ObjectId(id)) }
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

            // 4.1 Ensure selected users are active
            if (allSelectedUserIds.length > 0) {
                await db.collection('users').updateMany(
                    {
                        company_id: user.company_id,
                        _id: { $in: allSelectedUserIds.map(id => new ObjectId(id)) }
                    },
                    {
                        $set: {
                            status: 'active',
                            access_mode: 'active'
                        },
                        $unset: {
                            inactive_at: "",
                            inactive_reason: ""
                        }
                    }
                );
            }

            // If the new plan allows 0 collaborators, clear them from the active business
            if ((newLimits.max_collaborators || 0) === 0) {
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
                // Otherwise, update with the selected collaborators
                await db.collection('user_businesses').updateOne(
                    { _id: new ObjectId(active_business_id) },
                    {
                        $set: {
                            collaborators: active_collaborator_ids.map(id => new ObjectId(id)),
                            updated_at: new Date()
                        }
                    }
                );
            }

            // Also handle any other possible field for viewers/users in business if they exist (defensive)
            if ((newLimits.max_viewers || 0) === 0 || (newLimits.max_users || 0) === 0) {
                 const unsetFields = {};
                 if ((newLimits.max_viewers || 0) === 0) unsetFields.viewers = [];
                 if ((newLimits.max_users || 0) === 0) unsetFields.users = [];
                 
                 if (Object.keys(unsetFields).length > 0) {
                     await db.collection('user_businesses').updateOne(
                         { _id: new ObjectId(active_business_id) },
                         { $set: unsetFields }
                     );
                 }
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

            // 6. Sync with Stripe
            let stripeSubscriptionId = company?.stripe_subscription_id;
            let periodStart = new Date();
            let periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            if (newPlan.stripe_price_id) {
                try {
                    if (stripeSubscriptionId) {
                        console.log(`Updating Stripe subscription ${stripeSubscriptionId} to price ${newPlan.stripe_price_id} (Downgrade)`);
                        const subscription = await StripeService.updateSubscription(stripeSubscriptionId, {
                            items: [{
                                id: (await StripeService.retrieveSubscription(stripeSubscriptionId)).items.data[0].id,
                                price: newPlan.stripe_price_id,
                            }],
                            proration_behavior: 'always_invoice',
                        });
                        if (subscription.current_period_start) periodStart = new Date(subscription.current_period_start * 1000);
                        if (subscription.current_period_end) periodEnd = new Date(subscription.current_period_end * 1000);
                    }
                } catch (stripeError) {
                    console.error('Stripe sync failed during downgrade:', stripeError);
                }
            }

            // 7. Update company plan + snapshot current limits
            const planSnapshot = TierService.buildPlanSnapshot(newPlan);
            await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        subscription_plan: newPlan.name,
                        plan_snapshot: planSnapshot,
                        stripe_subscription_id: stripeSubscriptionId,
                        subscription_start_date: periodStart,
                        subscription_end_date: periodEnd,
                        expires_at: periodEnd,
                        updated_at: new Date(),
                        status: 'active'
                    }
                }
            );

            // Record in billing history
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: newPlan.price || newPlan.price_usd || TIER_LIMITS[newPlan.name.toLowerCase()]?.price_usd || 0,
                date: new Date(),
                type: 'downgrade',
                stripe_subscription_id: stripeSubscriptionId
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
                archive_business_ids = [],
                reactivate_collaborator_ids = [],
                archive_collaborator_ids = [],
                reactivate_user_ids = [],
                archive_user_ids = [],
                reactivate_viewer_ids = [],
                archive_viewer_ids = []
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


            const limits = TierService.getLimitsForPlan(newPlan);

            // 1. Validate limits
            const companyUsers = await db.collection('users')
                .find({ company_id: user.company_id })
                .project({ _id: 1 })
                .toArray();
            const companyUserIds = companyUsers.map(u => u._id);

            const activeBusinessesCount = await db.collection('user_businesses').countDocuments({
                user_id: { $in: companyUserIds },
                access_mode: 'active',
                status: { $ne: 'deleted' }
            });

            if (activeBusinessesCount + reactivate_business_ids.length - archive_business_ids.length > limits.max_workspaces) {
                 return res.status(400).json({
                    error: `You can only have ${limits.max_workspaces} active workspaces for this plan.`,
                    plan: newPlan.name,
                    limits: {
                        max_workspaces: limits.max_workspaces
                    }
                });
            }

            // 2. Reactivate Businesses
            if (reactivate_business_ids.length > 0) {
                await db.collection('user_businesses').updateMany(
                    {
                        _id: { $in: reactivate_business_ids.map(id => new ObjectId(id)) }
                    },
                    { $set: { access_mode: 'active', status: 'active', updated_at: new Date() } }
                );

                // Unlock projects in these businesses
                await db.collection('projects').updateMany(
                    { business_id: { $in: reactivate_business_ids.map(id => new ObjectId(id)) } },
                    {
                        $set: { is_readonly: false, updated_at: new Date() },
                        $unset: { locked_at: "", lock_reason: "" }
                    }
                );
            }

            // 2.1 Archive Businesses
            if (archive_business_ids.length > 0) {
                await db.collection('user_businesses').updateMany(
                    { _id: { $in: archive_business_ids.map(id => new ObjectId(id)) } },
                    { $set: { access_mode: 'archived', status: 'archived', archived_at: new Date(), archived_reason: 'plan_upgrade_deselect' } }
                );

                // Lock projects in these businesses
                await db.collection('projects').updateMany(
                    { business_id: { $in: archive_business_ids.map(id => new ObjectId(id)) } },
                    { $set: { is_readonly: true, locked_at: new Date(), lock_reason: 'business_archived' } }
                );
            }

            // 3. Reactivate Users (Collaborators, Users, Viewers)
            const allReactivateUserIds = [
                ...reactivate_collaborator_ids,
                ...reactivate_user_ids,
                ...reactivate_viewer_ids
            ];
            
            if (allReactivateUserIds.length > 0) {
                await db.collection('users').updateMany(
                    {
                        _id: { $in: allReactivateUserIds.map(id => new ObjectId(id)) },
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

            // 3.1 Archive Users
            const allArchiveUserIds = [
                ...archive_collaborator_ids,
                ...archive_user_ids,
                ...archive_viewer_ids
            ];
            
            if (allArchiveUserIds.length > 0) {
                await db.collection('users').updateMany(
                    {
                        _id: { $in: allArchiveUserIds.map(id => new ObjectId(id)) },
                        company_id: user.company_id
                    },
                    {
                        $set: {
                            status: 'inactive',
                            access_mode: 'archived',
                            inactive_reason: 'plan_upgrade_deselect',
                            inactive_at: new Date()
                        }
                    }
                );
            }

            // 4. Sync with Stripe
            const company = await db.collection('companies').findOne({ _id: user.company_id });
            let stripeSubscriptionId = company?.stripe_subscription_id;
            let periodStart = new Date();
            let periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            if (newPlan.stripe_price_id) {
                try {
                    if (stripeSubscriptionId) {
                        console.log(`Updating Stripe subscription ${stripeSubscriptionId} to price ${newPlan.stripe_price_id} (Reactivation)`);
                        const subscription = await StripeService.updateSubscription(stripeSubscriptionId, {
                            items: [{
                                id: (await StripeService.retrieveSubscription(stripeSubscriptionId)).items.data[0].id,
                                price: newPlan.stripe_price_id,
                            }],
                            proration_behavior: 'always_invoice',
                        });
                        if (subscription.current_period_start) periodStart = new Date(subscription.current_period_start * 1000);
                        if (subscription.current_period_end) periodEnd = new Date(subscription.current_period_end * 1000);
                    } else if (company?.stripe_customer_id) {
                        console.log(`Creating Stripe subscription for ${company.stripe_customer_id} (Reactivation)`);
                        const subscription = await StripeService.createSubscription(
                            company.stripe_customer_id,
                            newPlan.stripe_price_id,
                            company.stripe_payment_method_id
                        );
                        stripeSubscriptionId = subscription.id;
                        if (subscription.current_period_start) periodStart = new Date(subscription.current_period_start * 1000);
                        if (subscription.current_period_end) periodEnd = new Date(subscription.current_period_end * 1000);
                    }
                } catch (stripeError) {
                    console.error('Stripe sync failed during reactivation:', stripeError);
                }
            }

            // 5. Finally update the plan + snapshot current limits for this renewal
            const planSnapshot = TierService.buildPlanSnapshot(newPlan);
            await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        subscription_plan: newPlan.name,
                        plan_snapshot: planSnapshot,
                        stripe_subscription_id: stripeSubscriptionId,
                        subscription_start_date: periodStart,
                        subscription_end_date: periodEnd,
                        expires_at: periodEnd,
                        updated_at: new Date(),
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
                type: 'reactivation',
                stripe_subscription_id: stripeSubscriptionId
            });

            // Return updated details
            return SubscriptionController.getDetails(req, res);

        } catch (error) {
            console.error('Reactivation error:', error);
            res.status(500).json({ error: error.message });
        }
    }

    static async addPaymentMethod(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;
            const { paymentMethodId, setAsDefault = true } = req.body;

            if (!paymentMethodId) {
                return res.status(400).json({ error: 'paymentMethodId is required' });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user?.company_id) return res.status(404).json({ error: 'Company not found' });

            const company = await db.collection('companies').findOne({ _id: user.company_id });

            let customerId = company?.stripe_customer_id;

            if (!customerId) {
                // Create Stripe customer on first card add
                const customer = await StripeService.createCustomer(user.email, user.name, paymentMethodId, setAsDefault);
                customerId = customer.id;
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { stripe_customer_id: customerId } }
                );
            } else {
                await StripeService.attachPaymentMethod(paymentMethodId, customerId);
            }

            if (setAsDefault) {
                await StripeService.updateCustomer(customerId, {
                    invoice_settings: { default_payment_method: paymentMethodId }
                });
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId } }
                );
            } else {
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { stripe_customer_id: customerId } }
                );
            }

            // Return refreshed payment methods list
            const methods = await StripeService.listPaymentMethods(customerId);
            const updatedCompany = await db.collection('companies').findOne({ _id: user.company_id });
            res.json({
                payment_methods: methods.map(pm => ({
                    id: pm.id,
                    brand: pm.card.brand,
                    last4: pm.card.last4,
                    exp_month: pm.card.exp_month,
                    exp_year: pm.card.exp_year
                })),
                default_payment_method_id: updatedCompany.stripe_payment_method_id
            });
        } catch (error) {
            console.error('Failed to add payment method:', error);
            res.status(500).json({ error: error.message || 'Failed to add payment method' });
        }
    }

    static async removePaymentMethod(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;
            const { paymentMethodId } = req.params;

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user?.company_id) return res.status(404).json({ error: 'Company not found' });

            const company = await db.collection('companies').findOne({ _id: user.company_id });

            if (!company?.stripe_customer_id) {
                return res.status(400).json({ error: 'No Stripe customer found' });
            }

            await StripeService.detachPaymentMethod(paymentMethodId);

            // If removed was the default, promote the next available card as default
            let newDefaultId = company.stripe_payment_method_id;
            if (company.stripe_payment_method_id === paymentMethodId) {
                const remaining = await StripeService.listPaymentMethods(company.stripe_customer_id);
                newDefaultId = remaining[0]?.id || null;
                if (newDefaultId) {
                    await StripeService.updateCustomer(company.stripe_customer_id, {
                        invoice_settings: { default_payment_method: newDefaultId }
                    });
                }
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { stripe_payment_method_id: newDefaultId } }
                );
            }

            // Return refreshed payment methods list
            const methods = await StripeService.listPaymentMethods(company.stripe_customer_id);
            res.json({
                payment_methods: methods.map(pm => ({
                    id: pm.id,
                    brand: pm.card.brand,
                    last4: pm.card.last4,
                    exp_month: pm.card.exp_month,
                    exp_year: pm.card.exp_year
                })),
                default_payment_method_id: newDefaultId
            });
        } catch (error) {
            console.error('Failed to remove payment method:', error);
            res.status(500).json({ error: error.message || 'Failed to remove payment method' });
        }
    }

    static async setDefaultPaymentMethod(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;
            const { paymentMethodId } = req.body;

            if (!paymentMethodId) {
                return res.status(400).json({ error: 'paymentMethodId is required' });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user?.company_id) return res.status(404).json({ error: 'Company not found' });

            const company = await db.collection('companies').findOne({ _id: user.company_id });

            if (!company?.stripe_customer_id) {
                return res.status(400).json({ error: 'No Stripe customer found' });
            }

            // Update Stripe customer
            await StripeService.updateCustomer(company.stripe_customer_id, {
                invoice_settings: { default_payment_method: paymentMethodId }
            });

            // Update local DB
            await db.collection('companies').updateOne(
                { _id: user.company_id },
                { $set: { stripe_payment_method_id: paymentMethodId } }
            );

            // Return refreshed payment methods list
            const methods = await StripeService.listPaymentMethods(company.stripe_customer_id);
            res.json({
                payment_methods: methods.map(pm => ({
                    id: pm.id,
                    brand: pm.card.brand,
                    last4: pm.card.last4,
                    exp_month: pm.card.exp_month,
                    exp_year: pm.card.exp_year
                })),
                default_payment_method_id: paymentMethodId
            });
        } catch (error) {
            console.error('Failed to set default payment method:', error);
            res.status(500).json({ error: error.message || 'Failed to set default payment method' });
        }
    }
}

module.exports = SubscriptionController;

