const { getDB } = require('../config/database');
const { ObjectId } = require('mongodb');
const { TIER_LIMITS } = require('../config/constants');

class TierService {
    static async getUserTier(userId) {
        const db = getDB();

        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (!user || !user.company_id) return 'none';

        const company = await db.collection('companies').findOne({ _id: user.company_id });
        if (!company) return 'none';

        // Legacy companies created without a plan have locked access
        if (!company.plan_id) return 'none';

        // Cast plan_id to ObjectId to ensure correct MongoDB lookup, as it may be saved as a string
        const planObjId = typeof company.plan_id === 'string' ? new ObjectId(company.plan_id) : company.plan_id;
        const plan = await db.collection('plans').findOne({ _id: planObjId });
        
        return plan?.name?.toLowerCase() || 'none';
    }

    static isStripeAccountNull(company) {
        return !company.stripe_customer_id &&
            !company.stripe_subscription_id &&
            !company.stripe_payment_method_id;
    }

    static getLimitsForPlan(plan) {
        // Preferred source is the nested "limits" object, falling back to top-level fields
        // that may exist for legacy plans.
        const limitsObj = plan?.limits || {};

        return {
            max_workspaces:
                limitsObj.workspaces ??
                plan?.max_workspaces ??
                plan?.workspace_limit ??
                1,
            project:
                limitsObj.project ??
                limitsObj.projects ??
                plan?.can_create_projects ??
                plan?.max_projects ??  // Added support for max_projects
                true,
            max_collaborators:
                limitsObj.collaborators ??
                plan?.max_collaborators ??
                0,
            max_viewers:
                limitsObj.viewers ??
                plan?.max_viewers ??
                0,
            max_users:
                limitsObj.users ??
                plan?.max_users ??
                0,
            insight: limitsObj.insight ?? plan?.insight ?? false,
            strategic: limitsObj.strategic ?? plan?.strategic ?? false,
            pmf: limitsObj.pmf ?? plan?.pmf ?? false
        };
    }

    /**
     * Resolve tier limits primarily from the plans collection.
     * Falls back to TIER_LIMITS only if no matching plan exists.
     */
    static async getTierLimits(tierName) {
        const db = getDB();
        const normalizedTier = tierName?.toLowerCase()?.trim();

        // Look up plan by name (case-insensitive) so "Essential" / "essential" both work
        let plan = null;
        if (normalizedTier) {
            plan = await db.collection('plans').findOne({
                name: new RegExp(`^${normalizedTier}$`, 'i')
            });
        }

        if (plan) {
            return this.getLimitsForPlan(plan);
        }

        // If no matching plan is found in the DB, 
        // lock all access so they must purchase a plan.
        return {
            max_workspaces: 0,
            project: false,
            max_collaborators: 0,
            max_viewers: 0,
            max_users: 0,
            insight: false,
            strategic: false,
            pmf: false
        };
    }

    static async checkWorkspaceLimit(userBusinessesCount, tierName) {
        const limits = await this.getTierLimits(tierName);
        return userBusinessesCount < limits.max_workspaces;
    }

    static async canCreateProject(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.project;
    }

    static async canAddCollaborator(currentCollaboratorsCount, tierName) {
        const limits = await this.getTierLimits(tierName);
        return currentCollaboratorsCount < limits.max_collaborators;
    }

    static async canConvertInitiative(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.project;
    }

    static async canAccessExecution(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.project;
    }

    static async canAccessPMF(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.pmf;
    }
}

module.exports = TierService;
