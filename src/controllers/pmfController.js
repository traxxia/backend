const { ObjectId } = require("mongodb");
const PMFExecutiveSummaryModel = require("../models/pmfExecutiveSummaryModel");
const ProjectModel = require("../models/projectModel");
const { PROJECT_STATES, PROJECT_LAUNCH_STATUS } = require("../config/constants");

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

            const priorityTitle = priority.title || priority.action || priority.Action || priority.Title;
            const actions = priority.actions || priority.Actions || [];

            if (!priorityTitle) {
                return res.status(400).json({ error: "Priority title is required" });
            }

            if (!Array.isArray(actions) || actions.length === 0) {
                return res.status(400).json({ error: "Priority must have at least one action to kickstart projects" });
            }

            const createdProjectIds = [];

            for (const actionObj of actions) {
                const actionText = typeof actionObj === 'object' ? actionObj.action : actionObj;

                if (!actionText) continue;

                const projectData = {
                    business_id: new ObjectId(businessId),
                    user_id: new ObjectId(userId),
                    project_name: actionText.trim(),
                    project_type: "short term initiative",
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
                    impact: typeof actionObj === 'object' ? (actionObj.impact || "") : "",
                    effort: "",
                    risk: "",
                    strategic_theme: priorityTitle,
                    dependencies: "",
                    high_level_requirements: "",
                    scope_definition: "",
                    expected_outcome: priority.expected_impact || "",
                    success_metrics: "",
                    estimated_timeline: priority.timeline || "",
                    budget_estimate: ""
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
