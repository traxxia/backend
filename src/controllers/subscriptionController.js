const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const TierService = require('../services/tierService');

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
                    status: 'active'
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

            res.json({
                plan: planName,
                company_name: company?.company_name,
                start_date: startDate,
                end_date: expiresAt,
                expires_at: expiresAt,
                status: status,
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
                        limit: limits.can_create_projects ? 'unlimited' : 0
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

            // 4. Archive collaborator access (don't delete from DB)
            const activeBusiness = await db.collection('user_businesses').findOne({
                _id: new ObjectId(active_business_id)
            });

            let archivedCollabCount = 0;
            if (activeBusiness && activeBusiness.collaborators && activeBusiness.collaborators.length > 0) {
                const allCollaboratorIds = activeBusiness.collaborators.map(id => id.toString());
                const activeCollabIds = active_collaborator_ids.map(id => id.toString());
                const collabsToArchive = allCollaboratorIds.filter(id => !activeCollabIds.includes(id));
                archivedCollabCount = collabsToArchive.length;

                // Create archived_collaborators field to track who had access
                await db.collection('user_businesses').updateOne(
                    { _id: new ObjectId(active_business_id) },
                    {
                        $set: {
                            collaborators: active_collaborator_ids.map(id => new ObjectId(id)),
                            archived_collaborators: collabsToArchive.map(id => ({
                                user_id: new ObjectId(id),
                                archived_at: new Date(),
                                reason: 'plan_downgrade'
                            }))
                        }
                    }
                );
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

            // 7. Audit log
            const { logAuditEvent } = require('../services/auditService');
            await logAuditEvent(userId, 'plan_downgraded', {
                from_plan: currentPlan?.name || 'unknown',
                to_plan: newPlan.name,
                active_business_id,
                archived_businesses: businessesToArchive.length,
                active_collaborators: active_collaborator_ids.length,
                archived_collaborators: archivedCollabCount
            });

            res.json({
                message: 'Downgrade processed successfully',
                active_business_id,
                archived_businesses_count: businessesToArchive.length,
                active_collaborators_count: active_collaborator_ids.length,
                archived_collaborators_count: archivedCollabCount
            });

        } catch (error) {
            console.error('Downgrade processing error:', error);
            res.status(500).json({ error: 'Failed to process downgrade' });
        }
    }
}

module.exports = SubscriptionController;
