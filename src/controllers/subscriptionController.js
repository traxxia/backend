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
}

module.exports = SubscriptionController;
