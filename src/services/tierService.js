const { getDB } = require('../config/database');
const { ObjectId } = require('mongodb');

class TierService {
    static async getUserTier(userId) {
        const db = getDB();

        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (!user || !user.company_id) return 'unlimited';

        const company = await db.collection('companies').findOne({ _id: user.company_id });
        if (!company) return 'unlimited';

        // If all Stripe IDs are null/missing, give unlimited access
        if (this.isStripeAccountNull(company)) {
            return 'unlimited';
        }

        // Legacy companies created without a plan have unlimited access
        if (!company.plan_id) return 'unlimited';

        const plan = await db.collection('plans').findOne({ _id: company.plan_id });
        return plan?.name?.toLowerCase() || 'essential';
    }

    static isStripeAccountNull(company) {
        return !company.stripe_customer_id &&
            !company.stripe_subscription_id &&
            !company.stripe_payment_method_id;
    }

    /**
     * Build effective limits from a plan document, using TIER_LIMITS as a fallback
     * for legacy plans that don't yet have limit fields stored in MongoDB.
     */
    static getLimitsForPlan(plan) {
        // Prefer explicit limits stored on the plan document, with support for
        // both flat fields (workspace_limit, max_projects, etc.) and a nested
        // "limits" object as in:
        //   limits: { workspaces, projects, collaborators, viewers, users }
        const limitsObj = plan?.limits || {};

        return {
            max_workspaces:
                plan?.max_workspaces ??
                plan?.workspace_limit ??
                limitsObj.workspaces ??
                1,
            can_create_projects:
                plan?.can_create_projects ??
                (limitsObj.projects != null ? true : true),
            max_collaborators:
                plan?.max_collaborators ??
                limitsObj.collaborators ??
                0,
            max_viewers:
                plan?.max_viewers ??
                limitsObj.viewers ??
                0,
            max_users:
                plan?.max_users ??
                limitsObj.users ??
                0,
            max_projects:
                plan?.max_projects ??
                limitsObj.projects ??
                null,
            insight: plan?.insight ?? limitsObj.insight ?? false,
            strategic: plan?.strategic ?? limitsObj.strategic ?? false
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

        // If no matching plan is found in the DB (e.g. truly legacy/unlimited
        // accounts), treat limits as effectively unlimited rather than falling
        // back to any hard-coded constants.
        return {
            max_workspaces: Number.MAX_SAFE_INTEGER,
            can_create_projects: true,
            max_collaborators: Number.MAX_SAFE_INTEGER,
            max_viewers: Number.MAX_SAFE_INTEGER,
            max_users: Number.MAX_SAFE_INTEGER,
            max_projects: null,
            insight: true,
            strategic: true
        };
    }

    static async checkWorkspaceLimit(userBusinessesCount, tierName) {
        const limits = await this.getTierLimits(tierName);
        return userBusinessesCount < limits.max_workspaces;
    }

    static async canCreateProject(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.can_create_projects;
    }

    static async canAddCollaborator(currentCollaboratorsCount, tierName) {
        const limits = await this.getTierLimits(tierName);
        return currentCollaboratorsCount < limits.max_collaborators;
    }

    static async canConvertInitiative(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.can_create_projects;
    }

    static async canAccessExecution(tierName) {
        const limits = await this.getTierLimits(tierName);
        return limits.can_create_projects;
    }
}

module.exports = TierService;
