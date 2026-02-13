const { TIER_LIMITS } = require('../config/constants');

class TierService {
    static async getUserTier(userId) {
        const { getDB } = require('../config/database');
        const { ObjectId } = require('mongodb');
        const db = getDB();

        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (!user || !user.company_id) return 'essential';

        const company = await db.collection('companies').findOne({ _id: user.company_id });
        if (!company) return 'essential';

        // Legacy companies created without a plan have unlimited access
        if (!company.plan_id) return 'unlimited';

        const plan = await db.collection('plans').findOne({ _id: company.plan_id });
        return plan?.name?.toLowerCase() || 'essential';
    }

    static getTierLimits(tierName) {
        const normalizedTier = tierName?.toLowerCase() || 'essential';
        return TIER_LIMITS[normalizedTier] || TIER_LIMITS.essential;
    }

    static async checkWorkspaceLimit(userBusinessesCount, tierName) {
        const limits = this.getTierLimits(tierName);
        return userBusinessesCount < limits.max_workspaces;
    }

    static async canCreateProject(tierName) {
        const limits = this.getTierLimits(tierName);
        return limits.can_create_projects;
    }

    static async canAddCollaborator(currentCollaboratorsCount, tierName) {
        const limits = this.getTierLimits(tierName);
        return currentCollaboratorsCount < limits.max_collaborators;
    }

    static async canConvertInitiative(tierName) {
        const limits = this.getTierLimits(tierName);
        return limits.can_create_projects;
    }

    static async canAccessExecution(tierName) {
        const limits = this.getTierLimits(tierName);
        return limits.can_create_projects;
    }
}

module.exports = TierService;
