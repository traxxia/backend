const TierService = require('../services/tierService');
const { getDB } = require('../config/database');
const { ObjectId } = require('mongodb');

/**
 * Middleware to check if user has write access based on subscription tier and business access mode
 */
const checkWriteAccess = async (req, res, next) => {
    try {
        const tierName = await TierService.getUserTier(req.user._id);

        // Essential plan users can only edit active businesses
        if (tierName === 'essential') {
            const { business_id } = req.body || req.query || req.params;

            if (business_id) {
                const db = getDB();
                const business = await db.collection('user_businesses').findOne({
                    _id: new ObjectId(business_id)
                });

                if (!business) {
                    return res.status(404).json({ error: 'Business not found' });
                }

                // Check if business is archived or hidden
                if (business.access_mode === 'archived' || business.access_mode === 'hidden') {
                    return res.status(403).json({
                        error: 'This workspace is archived. Upgrade to Advanced to restore access.',
                        upgrade_required: true,
                        access_mode: business.access_mode
                    });
                }

                // Check if business is active (or has no access_mode set - legacy data)
                if (business.access_mode && business.access_mode !== 'active') {
                    return res.status(403).json({
                        error: 'Upgrade to Advanced plan to edit this workspace',
                        upgrade_required: true
                    });
                }
            }
        }

        next();
    } catch (error) {
        console.error('Write access check error:', error);
        res.status(500).json({ error: 'Failed to verify access permissions' });
    }
};

/**
 * Middleware to check if user can access collaborator features
 */
const checkCollaboratorAccess = async (req, res, next) => {
    try {
        const tierName = await TierService.getUserTier(req.user._id);

        if (tierName === 'essential') {
            return res.status(403).json({
                error: 'Collaborator features require Advanced plan',
                upgrade_required: true,
                feature: 'collaborators'
            });
        }

        next();
    } catch (error) {
        console.error('Collaborator access check error:', error);
        res.status(500).json({ error: 'Failed to verify collaborator access' });
    }
};

/**
 * Middleware to check if user can create projects
 */
const checkProjectCreation = async (req, res, next) => {
    try {
        const tierName = await TierService.getUserTier(req.user._id);
        const limits = TierService.getTierLimits(tierName);

        if (!limits.can_create_projects) {
            return res.status(403).json({
                error: 'Project creation requires Advanced plan',
                upgrade_required: true,
                feature: 'projects'
            });
        }

        next();
    } catch (error) {
        console.error('Project creation check error:', error);
        res.status(500).json({ error: 'Failed to verify project creation access' });
    }
};

module.exports = {
    checkWriteAccess,
    checkCollaboratorAccess,
    checkProjectCreation
};
