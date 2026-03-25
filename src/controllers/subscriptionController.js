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

            // Robust counting for businesses and users
            const companyIdStr = user.company_id.toString();
            const companyIdObj = new ObjectId(companyIdStr);
            const companyIdFilter = { $in: [companyIdStr, companyIdObj] };

            // 1. Get all company users (supporting both String and ObjectId for company_id)
            const companyUsers = await db.collection('users').find({
                company_id: companyIdFilter
            }).project({ _id: 1, role_id: 1, status: 1 }).toArray();

            const companyUserIds = companyUsers.map(u => u._id);
            const companyUserIdStrs = companyUsers.map(u => u._id.toString());
            const allUserIds = [...new Set([...companyUserIds, ...companyUserIdStrs])];

            // Helper to check if a user is active (explicit 'active' or missing status)
            const isItemActive = (item) => !item.status || item.status === 'active';

            // 2. Count Businesses (supporting items without a status field as active)
            const currentWorkspaces = await db.collection('user_businesses').countDocuments({
                user_id: { $in: allUserIds },
                status: { $in: ['active', null, undefined] }
            });

            // 3. Count Roles
            const collabRole = await db.collection('roles').findOne({ role_name: 'collaborator' });
            const viewerRole = await db.collection('roles').findOne({ role_name: 'viewer' });
            const userRole = await db.collection('roles').findOne({ role_name: 'user' });

            const currentCollaborators = companyUsers.filter(u =>
                isItemActive(u) && u.role_id?.toString() === collabRole?._id.toString()
            ).length;

            const currentViewers = companyUsers.filter(u =>
                isItemActive(u) && u.role_id?.toString() === viewerRole?._id.toString()
            ).length;

            const currentUsersWithUserRole = companyUsers.filter(u =>
                isItemActive(u) && u.role_id?.toString() === userRole?._id.toString()
            ).length;

            // 4. Count Projects across all company businesses
            const companyBusinesses = await db.collection('user_businesses')
                .find({ user_id: { $in: allUserIds } })
                .project({ _id: 1 })
                .toArray();
            const businessIds = companyBusinesses.map(b => b._id);
            const businessIdStrs = companyBusinesses.map(b => b._id.toString());
            const allBusinessIds = [...new Set([...businessIds, ...businessIdStrs])];

            const currentProjects = await db.collection('projects').countDocuments({
                business_id: { $in: allBusinessIds }
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
            let originalPlanLimits = null;
            let originalPlanPrice = null;

            if (company?.plan_id) {
                const livePlan = await db.collection('plans').findOne({ _id: company.plan_id });
                if (livePlan) {
                    const liveLimits = TierService.getLimitsForPlan(livePlan);
                    originalPlanPrice = livePlan.price || TIER_LIMITS[livePlan.name.toLowerCase()]?.price_usd || 0;
                    originalPlanLimits = {
                        workspaces: liveLimits.max_workspaces,
                        collaborators: liveLimits.max_collaborators,
                        viewers: liveLimits.max_viewers,
                        users: liveLimits.max_users,
                        project: liveLimits.project,
                        pmf: liveLimits.pmf,
                        insight: liveLimits.insight,
                        strategic: liveLimits.strategic
                    };

                    if (company.plan_snapshot?.snapshotted_at) {
                        const snap = company.plan_snapshot;
                        planUpdatedSinceSnapshot = (
                            liveLimits.max_workspaces !== snap.max_workspaces ||
                            liveLimits.max_collaborators !== snap.max_collaborators ||
                            liveLimits.max_viewers !== snap.max_viewers ||
                            liveLimits.max_users !== snap.max_users ||
                            liveLimits.project !== snap.project ||
                            liveLimits.insight !== snap.insight ||
                            liveLimits.strategic !== snap.strategic ||
                            liveLimits.pmf !== snap.pmf
                        );
                    }
                }
            }

            res.json({
                plan: planName,
                plan_price: company?.subscription_plan_price || TIER_LIMITS[planName.toLowerCase()]?.price_usd || 0,
                original_plan_price: originalPlanPrice,
                plan_limits: limits,
                original_plan_limits: originalPlanLimits,
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
                            workspaces: planLimits.max_workspaces,
                            collaborators: planLimits.max_collaborators,
                            viewers: planLimits.max_viewers,
                            users: planLimits.max_users,
                            project: planLimits.project,
                            pmf: planLimits.pmf,
                            insight: planLimits.insight,
                            strategic: planLimits.strategic
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
                        limit: limits.max_workspaces,
                        original_limit: originalPlanLimits?.workspaces ?? limits.max_workspaces
                    },
                    collaborators: {
                        current: currentCollaborators,
                        limit: limits.max_collaborators,
                        original_limit: originalPlanLimits?.collaborators ?? limits.max_collaborators
                    },
                    users: {
                        current: currentUsersWithUserRole,
                        limit: limits.max_users ?? 0,
                        original_limit: originalPlanLimits?.users ?? limits.max_users ?? 0
                    },
                    viewers: {
                        current: currentViewers,
                        limit: limits.max_viewers ?? 0,
                        original_limit: originalPlanLimits?.viewers ?? limits.max_viewers ?? 0
                    },
                    projects: {
                        current: currentProjects,
                        limit: limits.project,
                        original_limit: originalPlanLimits?.project ?? limits.project
                    },
                    pmf: limits.pmf ?? false,
                    insight: limits.insight ?? false,
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

            // Dynamically detect if configuration is needed based on usage vs new limits
            const isDowngrade = (
                usage.workspaces > (newLimits.max_workspaces || 0) ||
                usage.collaborators > (newLimits.max_collaborators || 0) ||
                usage.viewers > (newLimits.max_viewers || 0) ||
                usage.users > (newLimits.max_users || 0)
            );

            const currentLimits = await TierService.getCompanyLimits(user.company_id);
            const archivedUsage = await TierService.getCompanyArchivedUsage(user.company_id);
            const isReactivationPossible = (
                (newLimits.max_workspaces > (currentLimits.max_workspaces || 0) && archivedUsage.workspaces > 0) ||
                (newLimits.max_collaborators > (currentLimits.max_collaborators || 0) && archivedUsage.collaborators > 0) ||
                (newLimits.max_viewers > (currentLimits.max_viewers || 0) && archivedUsage.viewers > 0) ||
                (newLimits.max_users > (currentLimits.max_users || 0) && archivedUsage.users > 0)
            );

            if (isDowngrade || isReactivationPossible) {
                const companyUsers = await db.collection('users')
                    .find({ company_id: user.company_id })
                    .project({ _id: 1 })
                    .toArray();
                const companyUserIds = companyUsers.map(u => u._id);

                const archivedBusinesses = await db.collection('user_businesses')
                    .find({ user_id: { $in: companyUserIds }, access_mode: 'archived' })
                    .toArray();

                const activeBusinesses = await db.collection('user_businesses')
                    .find({ user_id: { $in: companyUserIds }, access_mode: 'active', status: { $ne: 'deleted' } })
                    .toArray();

                const roles = await db.collection('roles').find({}).toArray();
                const roleMap = roles.reduce((acc, r) => { acc[r._id.toString()] = r.role_name; return acc; }, {});

                const allInactiveUsers = await db.collection('users').find({
                    company_id: user.company_id,
                    status: 'inactive'
                }).toArray();

                const allActiveUsers = await db.collection('users').find({
                    company_id: user.company_id,
                    status: 'active'
                }).toArray();

                const features = [];

                if (newLimits.max_workspaces !== undefined || activeBusinesses.length > 0 || archivedBusinesses.length > 0) {
                    features.push({
                        id: 'workspaces',
                        title: 'Workspaces',
                        limit: newLimits.max_workspaces || 1,
                        active_items: activeBusinesses.map(b => ({ _id: b._id.toString(), name: b.business_name })),
                        archived_items: archivedBusinesses.map(b => ({ _id: b._id.toString(), name: b.business_name }))
                    });
                }

                ['collaborator', 'user', 'viewer'].forEach(roleKey => {
                    const mapUsers = (u) => ({
                        _id: u._id.toString(),
                        name: u.name,
                        email: u.email,
                        associated_business_ids: archivedBusinesses
                            .filter(b => b.collaborators?.some(cid => cid.toString() === u._id.toString()))
                            .map(b => b._id.toString())
                    });

                    const activeInRole = allActiveUsers.filter(u => roleMap[u.role_id?.toString()] === roleKey).map(mapUsers);
                    const inactiveInRole = allInactiveUsers.filter(u => roleMap[u.role_id?.toString()] === roleKey).map(mapUsers);

                    const limitKey = `max_${roleKey}s`;
                    const limitVal = newLimits[limitKey] || 0;

                    if (limitVal !== undefined || activeInRole.length > 0 || inactiveInRole.length > 0) {
                        const titles = { collaborator: 'Collaborators', user: 'Standard Users', viewer: 'Viewers' };
                        features.push({
                            id: roleKey + 's',
                            title: titles[roleKey],
                            limit: limitVal,
                            active_items: activeInRole,
                            archived_items: inactiveInRole
                        });
                    }
                });

                return res.status(200).json({
                    requires_configuration: true,
                    action: 'plan_configuration',
                    limits: newLimits,
                    plan_id: plan_id,
                    new_plan_name: newPlan.name,
                    configurable_features: features
                });
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

    static async processConfiguration(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;
            const { plan_id, selections } = req.body;
            // selections is an object like: { workspaces: ["id1", "id2"], collaborators: ["id3"], users: [], viewers: [] }

            if (!plan_id || !selections) {
                return res.status(400).json({ error: 'plan_id and selections are required' });
            }

            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (!user || !user.company_id) {
                return res.status(404).json({ error: 'User or company not found' });
            }

            const company = await db.collection('companies').findOne({ _id: user.company_id });
            const newPlan = await db.collection('plans').findOne({ _id: new ObjectId(plan_id) });
            const currentPlan = await db.collection('plans').findOne({ _id: company?.plan_id });

            if (!newPlan) return res.status(404).json({ error: 'Plan not found' });

            // Helper to fetch all users in company
            const companyUsers = await db.collection('users').find({ company_id: user.company_id }).project({ _id: 1 }).toArray();
            const companyUserIds = companyUsers.map(u => u._id);

            const newLimits = TierService.getLimitsForPlan(newPlan);

            // 1. Validate Selections against new limits
            const activeWorkspaceIds = (selections.workspaces || []).map(id => new ObjectId(id));
            if ((newLimits.max_workspaces || 0) > 0 && activeWorkspaceIds.length > newLimits.max_workspaces) {
                return res.status(400).json({ error: `Limit exceeded: Maximum ${newLimits.max_workspaces} workspaces allowed.` });
            }

            const activeCollaboratorIds = (selections.collaborators || []);
            if ((newLimits.max_collaborators || 0) > 0 && activeCollaboratorIds.length > newLimits.max_collaborators) {
                return res.status(400).json({ error: `Limit exceeded: Maximum ${newLimits.max_collaborators} collaborators allowed.` });
            }

            const activeViewerIds = (selections.viewers || []);
            if ((newLimits.max_viewers || 0) > 0 && activeViewerIds.length > newLimits.max_viewers) {
                return res.status(400).json({ error: `Limit exceeded: Maximum ${newLimits.max_viewers} viewers allowed.` });
            }

            const activeUserRoleIds = (selections.users || []);
            if ((newLimits.max_users || 0) > 0 && activeUserRoleIds.length > newLimits.max_users) {
                return res.status(400).json({ error: `Limit exceeded: Maximum ${newLimits.max_users} users allowed.` });
            }

            // 2. Process Workspaces
            
            // Set selected workspaces to active
            if (activeWorkspaceIds.length > 0) {
                await db.collection('user_businesses').updateMany(
                    { _id: { $in: activeWorkspaceIds }, user_id: { $in: companyUserIds } },
                    { $set: { access_mode: 'active', status: 'active', updated_at: new Date() } }
                );
                await db.collection('projects').updateMany(
                    { business_id: { $in: activeWorkspaceIds } },
                    { $set: { is_readonly: false, updated_at: new Date() }, $unset: { locked_at: "", lock_reason: "" } }
                );
            }

            // Set unselected workspaces to archived
            await db.collection('user_businesses').updateMany(
                { _id: { $nin: activeWorkspaceIds }, user_id: { $in: companyUserIds }, status: { $ne: 'deleted' } },
                { $set: { access_mode: 'archived', status: 'archived', archived_at: new Date(), archived_reason: 'plan_configuration' } }
            );

            // Lock projects in archived workspaces
            const archivedBusinessesList = await db.collection('user_businesses')
                .find({ _id: { $nin: activeWorkspaceIds }, user_id: { $in: companyUserIds }, status: 'archived' })
                .toArray();
            if (archivedBusinessesList.length > 0) {
                await db.collection('projects').updateMany(
                    { business_id: { $in: archivedBusinessesList.map(b => b._id) } },
                    { $set: { is_readonly: true, locked_at: new Date(), lock_reason: 'business_archived' } }
                );
            }

            // 2. Process Users (Collaborators, Users, Viewers)
            const activeUserIds = [
                ...(selections.collaborators || []),
                ...(selections.users || []),
                ...(selections.viewers || [])
            ].map(id => new ObjectId(id));

            // Set selected to active
            if (activeUserIds.length > 0) {
                await db.collection('users').updateMany(
                    { _id: { $in: activeUserIds }, company_id: user.company_id },
                    { $set: { status: 'active', access_mode: 'active', updated_at: new Date() }, $unset: { inactive_reason: "", inactive_at: "" } }
                );
            }

            // Set unselected to inactive
            const restrictedRoles = await db.collection('roles').find({ role_name: { $in: ['collaborator', 'viewer', 'user'] } }).project({ _id: 1 }).toArray();
            const restrictedRoleIds = restrictedRoles.map(r => r._id);

            await db.collection('users').updateMany(
                { _id: { $nin: activeUserIds }, company_id: user.company_id, role_id: { $in: restrictedRoleIds } },
                { $set: { status: 'inactive', access_mode: 'archived', inactive_reason: 'plan_configuration', inactive_at: new Date() } }
            );

            // 3. Sync with Stripe
            let stripeSubscriptionId = company?.stripe_subscription_id;
            let periodStart = new Date();
            let periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);

            if (newPlan.stripe_price_id) {
                try {
                    if (stripeSubscriptionId) {
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
                    console.error('Stripe sync failed during configuration:', stripeError);
                }
            }

            // 4. Update Company Plan and snapshot limits
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
            // Use static constant TIER_LIMITS if imported, else fallback
            const amount = newPlan.price_usd || newPlan.price || 0;
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: amount,
                date: new Date(),
                type: 'plan_configuration',
                stripe_subscription_id: stripeSubscriptionId
            });

            // 5. Audit Log
            const { logAuditEvent } = require('../services/auditService');
            await logAuditEvent(userId, 'plan_configured', {
                from_plan: currentPlan?.name || 'unknown',
                to_plan: newPlan.name,
                workspaces_active: selections.workspaces?.length || 0,
                users_active: (selections.users?.length || 0) + (selections.collaborators?.length || 0) + (selections.viewers?.length || 0)
            });

            return SubscriptionController.getDetails(req, res);
        } catch (error) {
            console.error('Configuration processing error:', error);
            res.status(500).json({ error: 'Failed to process configuration' });
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

