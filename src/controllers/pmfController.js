const { ObjectId } = require("mongodb");
const PMFExecutiveSummaryModel = require("../models/pmfExecutiveSummaryModel");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");
const UserModel = require("../models/userModel");
const TierService = require("../services/tierService");
const { getDB } = require("../config/database");
const { PROJECT_STATES, PROJECT_LAUNCH_STATUS } = require("../config/constants");

const ADMIN_ROLES = ["company_admin", "super_admin"];
const PROJECT_TYPES = ["immediate action", "short term initiative", "long term shift"];
const DEFAULT_PROJECT_TYPE = "immediate action";

// Permission matrix for project actions
function getProjectPermissions({
    projectStatus,
    isOwner,
    isCollaborator,
    isAdmin,
}) {
    const status = (projectStatus || "").toLowerCase();
    const canModify = isAdmin || isCollaborator || isOwner;

    switch (status) {
        case PROJECT_STATES.DRAFT:
            return {
                canCreate: canModify,
                canEdit: canModify,
            };
        default:
            return { canCreate: false, canEdit: canModify };
    }
}

// Normalize string fields
function normalizeString(value) {
    return typeof value === "string" ? value : "";
}

class PMFController {
    static async getKickstartData(req, res) {
        try {
            const { businessId } = req.params;

            if (!ObjectId.isValid(businessId)) {
                return res.status(400).json({ error: "Invalid business ID" });
            }

            const summaryDoc = await PMFExecutiveSummaryModel.findByBusinessId(businessId);
            if (!summaryDoc || !summaryDoc.summary) {
                return res.status(404).json({ error: "Executive summary not found" });
            }

            // Extract Top Priorities
            const priorities = summaryDoc.summary.top_priorities || summaryDoc.summary.topPriorities || [];

            // Fetch existing projects for this business to check for duplicates
            const existingProjects = await ProjectModel.findAll({ business_id: new ObjectId(businessId) });
            const existingProjectNames = existingProjects.map(p => p.project_name.toLowerCase().trim());

            const kickstartData = priorities.map(priority => {
                const title = priority.title || priority.action || priority.Action || priority.Title || "";
                const rawActions = priority.actions || priority.Actions || [];

                // Map actions and check if they are already kickstarted
                const actionsWithStatus = rawActions.map(actionObj => {
                    const actionText = typeof actionObj === 'object' ? actionObj.action : actionObj;
                    return {
                        ...(typeof actionObj === 'object' ? actionObj : { action: actionObj }),
                        action: actionText,
                        isKickstarted: existingProjectNames.includes(actionText.toLowerCase().trim())
                    };
                });

                return {
                    ...priority,
                    title: title,
                    actions: actionsWithStatus,
                    isKickstarted: actionsWithStatus.every(a => a.isKickstarted) && actionsWithStatus.length > 0
                };
            });

            res.json({ priorities: kickstartData });
        } catch (error) {
            console.error("Error fetching kickstart data:", error);
            res.status(500).json({ error: "Failed to fetch kickstart data" });
        }
    }

    static async kickstartProject(req, res) {
        try {
            const { businessId, priority } = req.body;
            const userId = req.user._id;

            if (!businessId || !priority) {
                return res.status(400).json({ error: "businessId and priority are required" });
            }

            if (!ObjectId.isValid(businessId)) {
                return res.status(400).json({ error: "Invalid business ID" });
            }

            // Check business
            const business = await BusinessModel.findById(businessId);
            if (!business) {
                return res.status(404).json({ error: "Business not found" });
            }

            // Tier check
            const tierName = await TierService.getUserTier(req.user._id);
            if (!await TierService.canCreateProject(tierName)) {
                return res.status(403).json({
                    error: `Project creation is locked for ${tierName} plan. Upgrade to Advanced to execute your strategy.`
                });
            }

            // User-collaborator auto-assignment (matching ProjectController)
            if (!ADMIN_ROLES.includes(req.user.role.role_name) && business.user_id) {
                const ownerId = business.user_id.toString();
                const ownerUser = await UserModel.findById(ownerId);

                if (ownerUser) {
                    const db = getDB();
                    const roleDoc = await db.collection("roles").findOne({ _id: ownerUser.role_id });
                    const ownerRoleName = roleDoc?.role_name;

                    if (["user", "viewer"].includes(ownerRoleName)) {
                        await UserModel.updateRole(ownerId, "collaborator");
                        await BusinessModel.addCollaborator(businessId, ownerId);
                        console.log(`Role auto-updated: userId ${ownerId} → collaborator for businessId ${businessId}`);
                    }
                }
            }

            const priorityTitle = priority.title || priority.action || priority.Action || priority.Title;
            const actions = priority.actions || priority.Actions || [];

            if (!priorityTitle) {
                return res.status(400).json({ error: "Priority title is required" });
            }

            if (!Array.isArray(actions) || actions.length === 0) {
                return res.status(400).json({ error: "Priority must have at least one action to kickstart projects" });
            }

            // Permission check
            const isOwner = business.user_id.toString() === req.user._id.toString();
            const isCollaborator = business.collaborators?.some(
                (id) => id.toString() === req.user._id.toString()
            );
            const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

            // Auto-add non-admin owner as collaborator if missing
            const ownerIdStr = business.user_id?.toString();
            if (ownerIdStr) {
                const ownerUser = await UserModel.findById(ownerIdStr);
                let ownerRoleName = null;
                if (ownerUser?.role_id) {
                    const db = getDB();
                    const roleDoc = await db.collection("roles").findOne({ _id: ownerUser.role_id });
                    ownerRoleName = roleDoc?.role_name;
                }

                if (!ADMIN_ROLES.includes(ownerRoleName)) {
                    const alreadyCollaborator = business.collaborators?.some(id => id.toString() === ownerIdStr);
                    if (!alreadyCollaborator) {
                        await BusinessModel.addCollaborator(businessId, ownerIdStr);
                        if (!Array.isArray(business.collaborators)) business.collaborators = [];
                        business.collaborators.push(new ObjectId(ownerIdStr));
                    }
                }
            }

            if (isAdmin && (!Array.isArray(business.collaborators) || business.collaborators.length === 0)) {
                return res.status(400).json({
                    error: "Please add at least one collaborator before creating a project",
                });
            }

            const permissions = getProjectPermissions({
                projectStatus: PROJECT_STATES.DRAFT,
                isOwner,
                isCollaborator,
                isAdmin,
            });

            if (!permissions.canCreate) {
                return res.status(403).json({
                    error: `You cannot create a project when business is in '${business.status}' state`,
                });
            }

            if (!(isAdmin || isCollaborator)) {
                return res.status(403).json({
                    error: "Only collaborators or admins can create or edit projects",
                });
            }

            const createdProjectIds = [];

            for (const actionObj of actions) {
                const actionText = typeof actionObj === 'object' ? actionObj.action : actionObj;

                if (!actionText) continue;

                const projectData = {
                    business_id: new ObjectId(businessId),
                    user_id: new ObjectId(userId),
                    project_name: actionText.trim(),
                    project_type: DEFAULT_PROJECT_TYPE,
                    description: typeof actionObj === 'object'
                        ? `PMF Tactical Action: ${actionText}\nImpact: ${actionObj.impact || 'N/A'}\nStatus: ${actionObj.status || 'N/A'}`
                        : `PMF Tactical Action: ${actionText}`,
                    why_this_matters: `Strategic priority: ${priorityTitle}`,
                    strategic_decision: "",
                    accountable_owner: "",
                    key_assumptions: [],
                    learning_state: "Testing",
                    success_criteria: "",
                    kill_criteria: "",
                    review_cadence: "",
                    status: PROJECT_STATES.DRAFT,
                    launch_status: PROJECT_LAUNCH_STATUS.UNLAUNCHED,
                    impact: normalizeString(typeof actionObj === 'object' ? (actionObj.impact || "") : ""),
                    effort: "",
                    risk: "",
                    strategic_theme: normalizeString(priorityTitle),
                    dependencies: "",
                    high_level_requirements: "",
                    scope_definition: "",
                    expected_outcome: normalizeString(priority.expected_impact || ""),
                    success_metrics: "",
                    estimated_timeline: normalizeString(priority.timeline || ""),
                    budget_estimate: "",
                    created_at: new Date(),
                    updated_at: new Date(),
                };

                const insertedId = await ProjectModel.create(projectData);
                createdProjectIds.push(insertedId);
            }

            res.status(201).json({
                message: `${createdProjectIds.length} projects kickstarted successfully`,
                projectIds: createdProjectIds
            });
        } catch (error) {
            console.error("Error kickstarting projects:", error);
            res.status(500).json({ error: "Failed to kickstart projects" });
        }
    }
}

module.exports = PMFController;
