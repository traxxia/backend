const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const TierService = require('../services/tierService');
const StripeService = require('../services/stripeService');
const cacheUtil = require('../utils/cache');

class SubscriptionController {
    static async getDetails(req, res) {
        try {
            const db = getDB();
            const userId = req.user._id;



            // Step 1: Initial user fetch to resolve company context
            const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

            if (!user || !user.company_id) {
                const data = {
                    plan: 'None',
                    start_date: user?.created_at || new Date(),
                    end_date: null,
                    expires_at: null,
                    status: 'inactive',
                    available_plans: [],
                    billing_history: []
                };
                return res.json(data);
            }

            const companyIdStr = user.company_id.toString();
            const companyIdObj = new ObjectId(companyIdStr);
            const companyIdFilter = { $in: [companyIdStr, companyIdObj] };

            // Step 2: Parallelize first wave of independent data fetching
            const [
                company,
                planName,
                limits,
                companyUsers,
                roles,
                availablePlans,
                billingHistory,
                currentWorkspaces,
                companyBusinesses
            ] = await Promise.all([
                db.collection('companies').findOne({ _id: user.company_id }),
                TierService.getUserTier(userId),
                TierService.getCompanyLimits(user.company_id),
                db.collection('users').find({ company_id: companyIdFilter }).project({ _id: 1, role_id: 1, status: 1 }).toArray(),
                db.collection('roles').find({ role_name: { $in: ['collaborator', 'viewer', 'user', 'company_admin', 'super_admin'] } }).toArray(),
                db.collection('plans').find({ status: 'active' }).sort({ _id: 1 }).toArray(),
                db.collection('billing_history').find({ company_id: user.company_id }).sort({ date: -1 }).toArray(),
                db.collection('user_businesses').countDocuments({
                    user_id: { $in: [userId.toString(), new ObjectId(userId)] }, // Wait, usage logic should likely use allUserIds. Refined below.
                    status: { $nin: ['deleted', 'archived', 'inactive'] }
                }),
                db.collection('user_businesses').find({ 
                    $or: [
                        { user_id: { $in: [userId.toString(), new ObjectId(userId)] } }, 
                        { company_id: user.company_id }
                    ] 
                }).project({ _id: 1, status: 1, access_mode: 1 }).toArray()
            ]);

            // Map roles for quick access
            const roleMap = {};
            roles.forEach(r => roleMap[r.role_name] = r);
            const roleIdToNameMap = {};
            roles.forEach(r => roleIdToNameMap[r._id.toString()] = r.role_name);

            // Step 3: Parallelize secondary wave (Usage counting & Stripe)
            const companyUserIds = companyUsers.map(u => u._id);
            const companyUserIdStrs = companyUsers.map(u => u._id.toString());
            const allUserIds = [...new Set([...companyUserIds, ...companyUserIdStrs])];

            const businessIdStrs = companyBusinesses.map(b => b._id.toString());
            const allBusinessIds = [...new Set([...companyBusinesses.map(b => b._id), ...businessIdStrs])];

            const isItemActive = (item) => !item.status || item.status === 'active';

            const [currentProjects, paymentMethodsData, livePlan, actualWorkspacesCount] = await Promise.all([
                db.collection('projects').countDocuments({ business_id: { $in: allBusinessIds } }),
                company?.stripe_customer_id ? StripeService.listPaymentMethods(company.stripe_customer_id).catch(() => []) : Promise.resolve([]),
                company?.plan_id ? db.collection('plans').findOne({ _id: company.plan_id }) : Promise.resolve(null),
                db.collection('user_businesses').countDocuments({
                    user_id: { $in: allUserIds },
                    status: { $nin: ['deleted', 'archived', 'inactive'] }
                })
            ]);



            const currentCollaborators = companyUsers.filter(u =>
                isItemActive(u) && roleIdToNameMap[u.role_id?.toString()] === 'collaborator'
            ).length;

            const currentViewers = companyUsers.filter(u =>
                isItemActive(u) && roleIdToNameMap[u.role_id?.toString()] === 'viewer'
            ).length;

            const currentUsersWithUserRole = companyUsers.filter(u =>
                isItemActive(u) && (roleIdToNameMap[u.role_id?.toString()] === 'user' || roleIdToNameMap[u.role_id?.toString()] === 'company_admin')
            ).length;

            const paymentMethods = paymentMethodsData.map(pm => ({
                id: pm.id,
                brand: pm.card.brand,
                last4: pm.card.last4,
                exp_month: pm.card.exp_month,
                exp_year: pm.card.exp_year
            }));
            const defaultPaymentMethodId = company?.stripe_payment_method_id;

            // Determine if the live plan limits differ from the customer's snapshot
            let planUpdatedSinceSnapshot = false;
            let originalPlanLimits = null;
            let originalPlanPrice = null;
            let currentPlanPeriod = 'month';

            if (livePlan) {
                currentPlanPeriod = livePlan.interval || livePlan.period || 'month';
                const liveLimits = TierService.getLimitsForPlan(livePlan);
                originalPlanPrice = livePlan.price || livePlan.price_usd || 0;
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

                if (company?.plan_snapshot?.snapshotted_at) {
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

            // Expiration Logic
            let expiresAt = company?.subscription_end_date || company?.expires_at;
            let startDate = company?.subscription_start_date || company?.created_at || user.created_at || new Date();
            let status = company?.subscription_status || company?.status || 'active';

            const isManualAccount = TierService.isStripeAccountNull(company || {});

            if (!expiresAt) {
                const interval = company?.plan_snapshot?.interval || 'month';
                expiresAt = TierService.calculateExpiryDate(startDate, interval);
            }

            // Check if expired
            if (new Date() > new Date(expiresAt) && status !== 'expired') {
                status = 'expired';
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { status: 'expired' } }
                );
            }

            if (isManualAccount && status === 'expired') status = 'active';
            if (isManualAccount) expiresAt = null;

            // Calculate total days in current billing cycle
            let totalDaysCycle = 31;
            if (startDate && expiresAt) {
                const s = new Date(startDate);
                const e = new Date(expiresAt);
                totalDaysCycle = Math.max(1, Math.round((e - s) / (1000 * 60 * 60 * 24)));
            }

            const billingCycle = currentPlanPeriod === 'year' ? 'yearly' : 'monthly';

            const responseData = {
                plan: planName,
                billing_cycle: billingCycle,
                total_days: totalDaysCycle,
                plan_price: company?.subscription_plan_price || originalPlanPrice || 0,
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
                        price: p.price || 0,
                        period: p.interval || p.period || 'month',
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
                }).sort((a, b) => a.price - b.price),
                billing_history: billingHistory.map(bh => ({
                    date: bh.date,
                    plan_name: bh.plan_name,
                    amount: bh.amount
                })),
                usage: {
                    workspaces: {
                        current: actualWorkspacesCount,
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
            };



            res.json(responseData);

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
                        // Check if already attached (specific PM ID) or duplicate card (fingerprint)
                        const pm = await StripeService.retrievePaymentMethod(paymentMethodId);

                        if (pm.customer !== customerId) {
                            // Check for fingerprint duplicate
                            const existingMethods = await StripeService.listPaymentMethods(customerId);
                            const newFingerprint = pm.card?.fingerprint;
                            const isDuplicate = existingMethods.some(ex => ex.card?.fingerprint === newFingerprint);

                            if (isDuplicate) {
                                return res.status(400).json({ error: 'This card is already linked to your account.' });
                            }

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

            // Always show configuration for new plans 
            if (true) {
                const companyUsers = await db.collection('users')
                    .find({ company_id: user.company_id })
                    .project({ _id: 1 })
                    .toArray();
                const companyUserIds = companyUsers.map(u => u._id);
                const companyUserIdStrs = companyUsers.map(u => u._id.toString());
                const allPotentialOwnerIds = [...new Set([...companyUserIds, ...companyUserIdStrs])];

                const companyBusinesses = await db.collection('user_businesses').find({
                    $or: [
                        { user_id: { $in: allPotentialOwnerIds } },
                        { company_id: user.company_id }
                    ],
                    status: { $ne: 'deleted' }
                }).toArray();

                const activeBusinesses = companyBusinesses.filter(b => b.access_mode !== 'archived' && !['archived', 'inactive'].includes(b.status));
                const archivedBusinesses = companyBusinesses.filter(b => b.access_mode === 'archived' || ['archived', 'inactive'].includes(b.status));

                const roles = await db.collection('roles').find({}).toArray();
                const roleMap = roles.reduce((acc, r) => { acc[r._id.toString()] = r.role_name; return acc; }, {});

                const allCompanyUsers = await db.collection('users').find({
                    company_id: user.company_id,
                    status: { $ne: 'deleted' }
                }).toArray();

                const allActiveUsers = allCompanyUsers.filter(u => !u.status || u.status === 'active');
                const allInactiveUsers = allCompanyUsers.filter(u => u.status && u.status !== 'active');

                const features = [];

                if (newLimits.max_workspaces !== undefined || activeBusinesses.length > 0 || archivedBusinesses.length > 0) {
                    features.push({
                        id: 'workspaces',
                        title: 'Workspaces',
                        limit: newLimits.max_workspaces ?? 1,
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

            // Record in billing history
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: newPlan.price || newPlan.price_usd || 0,
                date: new Date(),
                type: 'upgrade',
                stripe_subscription_id: company.stripe_subscription_id
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

            const companyUsers = await db.collection('users').find({ company_id: user.company_id }).project({ _id: 1 }).toArray();
            const allPotentialOwnerIds = [...new Set([
                ...companyUsers.map(u => u._id),
                ...companyUsers.map(u => u._id.toString())
            ])];

            const newLimits = TierService.getLimitsForPlan(newPlan);

            // 1. Process Workspaces
            const activeWorkspaceIds = (selections.workspaces || []).map(id => new ObjectId(id));

            const workspaceFilter = {
                $or: [
                    { user_id: { $in: allPotentialOwnerIds } },
                    { company_id: user.company_id }
                ],
                status: { $ne: 'deleted' }
            };

            if (activeWorkspaceIds.length > 0) {
                await db.collection('user_businesses').updateMany(
                    { ...workspaceFilter, _id: { $in: activeWorkspaceIds } },
                    { $set: { access_mode: 'active', status: 'active', updated_at: new Date() } }
                );
            }

            await db.collection('user_businesses').updateMany(
                { ...workspaceFilter, _id: { $nin: activeWorkspaceIds } },
                {
                    $set: {
                        access_mode: 'archived',
                        status: 'archived',
                        archived_at: new Date(),
                        collaborators: [],
                        allowed_ranking_collaborators: []
                    }
                }
            );

            // Cleanup project access for archived businesses
            const archivedBusinesses = await db.collection('user_businesses').find({
                ...workspaceFilter,
                _id: { $nin: activeWorkspaceIds }
            }).project({ _id: 1 }).toArray();

            if (archivedBusinesses.length > 0) {
                const archivedBusinessIds = archivedBusinesses.map(b => b._id);
                await db.collection('projects').updateMany(
                    { business_id: { $in: archivedBusinessIds } },
                    { $set: { allowed_collaborators: [], updated_at: new Date() } }
                );
            }

            // 2. Process Users
            const activeUserIds = [
                ...(selections.collaborators || []),
                ...(selections.users || []),
                ...(selections.viewers || [])
            ].map(id => new ObjectId(id));

            if (activeUserIds.length > 0) {
                await db.collection('users').updateMany(
                    { _id: { $in: activeUserIds }, company_id: user.company_id },
                    { $set: { status: 'active', access_mode: 'active', updated_at: new Date() } }
                );
            }

            const restrictedRoles = await db.collection('roles').find({ role_name: { $in: ['collaborator', 'viewer', 'user'] } }).project({ _id: 1 }).toArray();
            const restrictedRoleIds = restrictedRoles.map(r => r._id);

            const userFilter = {
                company_id: user.company_id,
                role_id: { $in: restrictedRoleIds }
            };

            await db.collection('users').updateMany(
                { ...userFilter, _id: { $nin: activeUserIds } },
                { $set: { status: 'inactive', access_mode: 'archived', inactive_at: new Date() } }
            );

            // Cleanup access for archived users
            const archivedUsers = await db.collection('users').find({
                ...userFilter,
                _id: { $nin: activeUserIds }
            }).project({ _id: 1 }).toArray();

            if (archivedUsers.length > 0) {
                const archivedUserIds = archivedUsers.map(u => u._id);

                const companyBusinesses = await db.collection('user_businesses')
                    .find(workspaceFilter)
                    .project({ _id: 1 })
                    .toArray();
                const businessIds = companyBusinesses.map(b => b._id);

                if (businessIds.length > 0) {
                    // Remove from allowed_ranking_collaborators in businesses
                    await db.collection('user_businesses').updateMany(
                        { _id: { $in: businessIds } },
                        {
                            $pull: {
                                allowed_ranking_collaborators: { $in: archivedUserIds },
                                collaborators: { $in: archivedUserIds }
                            }
                        }
                    );

                    // Remove from allowed_collaborators in projects
                    await db.collection('projects').updateMany(
                        { business_id: { $in: businessIds } },
                        { $pull: { allowed_collaborators: { $in: archivedUserIds } } }
                    );
                }
            }

            // 3. Update Company Plan and Dates
            const planSnapshot = TierService.buildPlanSnapshot(newPlan);
            const now = new Date();
            const interval = newPlan.interval || newPlan.period || 'month';
            const expiryDate = TierService.calculateExpiryDate(now, interval);

            await db.collection('companies').updateOne(
                { _id: user.company_id },
                {
                    $set: {
                        plan_id: new ObjectId(plan_id),
                        subscription_plan: newPlan.name,
                        subscription_plan_price: newPlan.price || newPlan.price_usd || 0,
                        plan_snapshot: planSnapshot,
                        subscription_start_date: now,
                        subscription_end_date: expiryDate,
                        expires_at: expiryDate,
                        updated_at: now,
                        status: 'active'
                    }
                }
            );

            // 4. Record in billing history
            await db.collection('billing_history').insertOne({
                company_id: user.company_id,
                plan_name: newPlan.name,
                amount: newPlan.price || newPlan.price_usd || 0,
                date: new Date(),
                type: 'upgrade',
                stripe_subscription_id: company.stripe_subscription_id
            });



            return res.json({ success: true, message: 'Plan configured successfully' });
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
                const customer = await StripeService.createCustomer(user.email, user.name, paymentMethodId, setAsDefault);
                customerId = customer.id;
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { stripe_customer_id: customerId } }
                );
            } else {
                // Check for duplicate card (fingerprint)
                try {
                    const pm = await StripeService.retrievePaymentMethod(paymentMethodId);

                    if (pm.customer !== customerId) {
                        // Check for fingerprint duplicate
                        const existingMethods = await StripeService.listPaymentMethods(customerId);
                        const newFingerprint = pm.card?.fingerprint;
                        const isDuplicate = existingMethods.some(ex => ex.card?.fingerprint === newFingerprint);

                        if (isDuplicate) {
                            return res.status(400).json({ error: 'This card is already linked to your account.' });
                        }

                        // Attach new payment method to existing customer
                        await StripeService.attachPaymentMethod(paymentMethodId, customerId);
                    }
                } catch (stripeError) {
                    console.error('Stripe payment validation failed:', stripeError);
                    return res.status(400).json({ error: 'Failed to validate card: ' + stripeError.message });
                }
            }

            if (setAsDefault) {
                await StripeService.updateCustomer(customerId, {
                    invoice_settings: { default_payment_method: paymentMethodId }
                });
                await db.collection('companies').updateOne(
                    { _id: user.company_id },
                    { $set: { stripe_customer_id: customerId, stripe_payment_method_id: paymentMethodId } }
                );
            }

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

            await StripeService.updateCustomer(company.stripe_customer_id, {
                invoice_settings: { default_payment_method: paymentMethodId }
            });

            await db.collection('companies').updateOne(
                { _id: user.company_id },
                { $set: { stripe_payment_method_id: paymentMethodId } }
            );

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
