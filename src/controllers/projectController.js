const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");
const ProjectRankingModel = require("../models/projectRankingModel");
const UserModel = require("../models/userModel")
const { getDB } = require("../config/database");
const TierService = require("../services/tierService");

const VALID_STATUS = ["Draft", "Active", "At Risk", "Paused", "Killed", "Scaled"];
const ADMIN_ROLES = ["company_admin", "super_admin"];
const PROJECT_TYPES = ["immediate action", "short term initiative", "long term shift"];
const DEFAULT_PROJECT_TYPE = "immediate action";



// Permission matrix for ALL project actions
function getProjectPermissions({
  businessStatus,
  isOwner,
  isCollaborator,
  isAdmin,
}) {
  const status = (businessStatus || "").toLowerCase();
  const canModify = isAdmin || isCollaborator || isOwner;

  switch (status) {
    case "draft":
      return {
        canCreate: canModify,
        canEdit: canModify,
      };
    case "prioritizing":
    case "prioritized":
      return {
        canCreate: false,
        canEdit: canModify,
      };

    // fully locked for non-admins by default
    case "launched":
      return {
        canCreate: false,
        canEdit: isAdmin,
      };

    case "reprioritizing":
      return {
        canCreate: false,
        canEdit: isAdmin,
      }

    default:
      // Default to allowing modification if status is unknown/active
      return { canCreate: false, canEdit: canModify };
  }
}

// Normalize string fields
function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

// Normalize budget_estimate for Mongo validation
function normalizeBudget(value) {
  if (value === "" || value === undefined || value === null) {
    return null;
  }
  const num = Number(value);
  return isNaN(num) ? null : num;
}

class ProjectController {
  static async getAll(req, res) {
    const db = getDB();

    try {
      const {
        business_id,
        user_id,
        impact,
        effort,
        risk,
        strategic_theme,
        q,
        status,
      } = req.query;

      const filter = {};

      if (business_id && ObjectId.isValid(business_id))
        filter.business_id = new ObjectId(business_id);

      if (user_id && ObjectId.isValid(user_id))
        filter.user_id = new ObjectId(user_id);

      if (impact) filter.impact = impact;
      if (effort) filter.effort = effort;
      if (risk) filter.risk = risk;
      if (strategic_theme) filter.strategic_theme = strategic_theme;
      if (status) filter.status = status;

      if (q) {
        filter.$or = [
          { project_name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ];
      }

      const raw = await ProjectModel.findAll(filter);
      const total = await ProjectModel.count(filter);
      let projects = await ProjectModel.populateCreatedBy(raw);

      let businessStatus = null;
      let businessAccessMode = null;
      if (business_id && ObjectId.isValid(business_id)) {
        const business = await BusinessModel.findById(business_id);
        if (business) {
          businessStatus = business.status;
          businessAccessMode = business.access_mode;
        }
      }

      projects = projects.map(project => ({
        ...project,
        allowed_collaborators: (project.allowed_collaborators || []).map(id => id.toString()),
        // Remove project status, we'll use business status instead
        // status: undefined,
      }));

      let ranking_lock_summary = {
        locked_users_count: 0,
        total_users: 0,
        locked_users: []
      };

      if (business_id && ObjectId.isValid(business_id)) {
        const business = await BusinessModel.findById(business_id);
        if (business) {
          const collaboratorIds = (business.collaborators || []).map(id => id.toString());
          const uniqueCollaboratorIds = [...new Set(collaboratorIds)];

          const users = await db.collection("users").find({
            _id: { $in: uniqueCollaboratorIds.map(id => new ObjectId(id)) }
          }).toArray();

          // Filter non-admins
          const nonAdminUsers = users.filter(u => !ADMIN_ROLES.includes(u.role_name));
          const nonAdminUserIds = nonAdminUsers.map(u => u._id);

          // Get locked rankings with user info
          const lockedRankings = await ProjectRankingModel.collection()
            .find({
              business_id: new ObjectId(business_id),
              locked: true,
              user_id: { $in: nonAdminUserIds }
            })
            .toArray();

          // Get unique locked user IDs
          const lockedUserIds = [...new Set(lockedRankings.map(r => r.user_id.toString()))];

          // Build locked users list with details
          const lockedUsers = nonAdminUsers
            .filter(u => lockedUserIds.includes(u._id.toString()))
            .map(u => ({
              user_id: u._id,
              name: u.name,
              email: u.email,
            }));

          ranking_lock_summary = {
            total_users: nonAdminUsers.length,
            locked_users_count: lockedUsers.length,
            locked_users: lockedUsers,
          };
        }
      }

      res.json({
        total,
        count: projects.length,
        projects,
        business_status: businessStatus, // Business status instead of project status
        business_access_mode: businessAccessMode,
        ranking_lock_summary,
      });
    } catch (err) {
      console.error("PROJECT GET ALL ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async getById(req, res) {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid project ID" });

      const raw = await ProjectModel.findById(id);
      if (!raw) return res.status(404).json({ error: "Project not found" });

      const [project] = await ProjectModel.populateCreatedBy(raw);

      res.json({ project });
    } catch (err) {
      console.error("PROJECT GET BY ID ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async create(req, res) {
    try {
      const {
        business_id,
        project_name,
        description,
        why_this_matters,
        strategic_decision,
        accountable_owner,
        key_assumptions,
        success_criteria,
        kill_criteria,
        review_cadence,
        status,
        impact,
        effort,
        risk,
        strategic_theme,
        dependencies,
        high_level_requirements,
        scope_definition,
        expected_outcome,
        success_metrics,
        estimated_timeline,
        budget_estimate,
        project_type,
        learning_state,
        last_reviewed,
        constraints_non_negotiables,
        explicitly_out_of_scope
      } = req.body;

      // Required fields
      if (!business_id || !project_name || !status) {
        return res.status(400).json({
          error: "business_id, project_name and status are required",
        });
      }

      // Check business
      const business = await BusinessModel.findById(business_id);
      if (!business)
        return res.status(404).json({ error: "Business not found" });

      const tierName = await TierService.getUserTier(req.user._id);
      if (!await TierService.canCreateProject(tierName)) {
        return res.status(403).json({
          error: `Project creation is locked for ${tierName} plan. Upgrade to Advanced to execute your strategy.`
        });
      }


      // User-collaborator
      if (!ADMIN_ROLES.includes(req.user.role.role_name) && business.user_id) {
        const ownerId = business.user_id.toString();


        const ownerUser = await require("../models/userModel").findById(ownerId);

        if (ownerUser) {

          const db = getDB();

          const roleDoc = await db.collection("roles").findOne({ _id: ownerUser.role_id });

          const ownerRoleName = roleDoc?.role_name;

          if (["user", "viewer"].includes(ownerRoleName)) {
            // Update role → collaborator
            await require("../models/userModel").updateRole(ownerId, "collaborator");

            // Add owner as business collaborator
            await BusinessModel.addCollaborator(business_id, ownerId);

            console.log(
              `Role auto-updated: userId ${ownerId} → collaborator for businessId ${business_id}`
            );
          }
        }
      }

      // Permission
      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(
        (id) => id.toString() === req.user._id.toString()
      );


      const ownerIdStr = business.user_id?.toString();

      if (ownerIdStr) {
        // Fetch business owner role
        const ownerUser = await UserModel.findById(ownerIdStr);

        let ownerRoleName = null;
        if (ownerUser?.role_id) {
          const db = getDB();
          const roleDoc = await db
            .collection("roles")
            .findOne({ _id: ownerUser.role_id });
          ownerRoleName = roleDoc?.role_name;
        }

        const ownerIsAdmin = ADMIN_ROLES.includes(ownerRoleName);

        // Auto-add if owner is not admin
        if (!ownerIsAdmin) {
          const alreadyCollaborator = Array.isArray(business.collaborators)
            ? business.collaborators.some((id) => id.toString() === ownerIdStr)
            : false;

          if (!alreadyCollaborator) {
            await BusinessModel.addCollaborator(
              business._id.toString(),
              ownerIdStr
            );

            if (!Array.isArray(business.collaborators)) {
              business.collaborators = [];
            }

            business.collaborators.push(new ObjectId(ownerIdStr));

            console.log(
              `Non-admin owner auto-added as collaborator: ${ownerIdStr}`
            );
          }
        }
      }


      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);


      if (
        isAdmin &&
        (!Array.isArray(business.collaborators) || business.collaborators.length === 0)
      ) {
        return res.status(400).json({
          error: "Please add at least one collaborator before creating a project",
        });
      }

      // NOTE: Owner alone cannot work on projects unless also collaborator
      const permissions = getProjectPermissions({
        businessStatus: business.status,
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

      // Normalize project_type (allow missing → default)
      const normalizedProjectType =
        project_type === undefined || project_type === null || project_type === ""
          ? DEFAULT_PROJECT_TYPE
          : project_type;

      if (!PROJECT_TYPES.includes(normalizedProjectType)) {
        return res.status(400).json({
          error: `project_type must be one of ${PROJECT_TYPES.join(", ")}`,
        });
      }

      // Normalize fields for MongoDB validation
      const data = {
        business_id: new ObjectId(business_id),
        user_id: new ObjectId(req.user._id),
        project_name: project_name.trim(),
        // project_type,
        project_type: normalizedProjectType,
        description: normalizeString(description),
        why_this_matters: normalizeString(why_this_matters),
        strategic_decision: normalizeString(strategic_decision),
        accountable_owner: normalizeString(accountable_owner),
        key_assumptions: Array.isArray(key_assumptions)
          ? key_assumptions.slice(0, 3).map(normalizeString)
          : [],
        success_criteria: normalizeString(success_criteria),
        kill_criteria: normalizeString(kill_criteria),
        review_cadence: normalizeString(review_cadence),

        status: status,
        learning_state: learning_state || "Testing",
        last_reviewed: last_reviewed ? new Date(last_reviewed) : null,

        impact: normalizeString(impact),
        effort: normalizeString(effort),
        risk: normalizeString(risk),
        strategic_theme: normalizeString(strategic_theme),
        dependencies: normalizeString(dependencies),
        high_level_requirements: normalizeString(constraints_non_negotiables || high_level_requirements),
        scope_definition: normalizeString(explicitly_out_of_scope || scope_definition),
        expected_outcome: normalizeString(expected_outcome),
        success_metrics: normalizeString(success_metrics),
        estimated_timeline: normalizeString(estimated_timeline),
        budget_estimate:
          budget_estimate === "" ||
            budget_estimate === null ||
            budget_estimate === undefined
            ? ""
            : String(budget_estimate).trim(),
        created_at: new Date(),
        updated_at: new Date(),
      };

      const insertedId = await ProjectModel.create(data);

      // Ensure the business owner is always a collaborator once projects exist
      if (!isAdmin) {
        try {
          if (business.user_id) {
            const ownerIdStr = business.user_id.toString();
            const alreadyCollaborator = Array.isArray(business.collaborators)
              ? business.collaborators.some((id) => id.toString() === ownerIdStr)
              : false;

            if (!alreadyCollaborator) {
              await BusinessModel.addCollaborator(
                business._id.toString(),
                ownerIdStr
              );
            }
          }
        } catch (collabErr) {
          console.error("Failed to auto-assign owner as collaborator:", collabErr);
          // We do not throw here to avoid blocking project creation if this step fails
        }
      }

      const raw = await ProjectModel.findById(insertedId);
      const [project] = await ProjectModel.populateCreatedBy(raw);

      res.status(201).json({
        message: "Project created successfully",
        project,
      });
    } catch (err) {
      console.error("PROJECT CREATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async update(req, res) {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      const existing = await ProjectModel.findById(id);
      if (!existing) return res.status(404).json({ error: "Not found" });

      const tierName = await TierService.getUserTier(req.user._id);
      if (!await TierService.canCreateProject(tierName)) {
        return res.status(403).json({
          error: `Project editing is locked for ${tierName} plan. Upgrade to Advanced to execute your strategy.`
        });
      }

      if (existing.status === "launched") {
        const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
        const isInAllowedCollabs = Array.isArray(existing.allowed_collaborators) &&
          existing.allowed_collaborators.some(id => id.toString() === req.user._id.toString());

        if (!isAdmin && !isInAllowedCollabs) {
          return res.status(403).json({
            error: "This project has been launched and cannot be updated anymore.",
          });
        }
      }

      if (req.body.status === "launched") {
        if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
          return res.status(403).json({
            error: "Only company_admin or super_admin can launch projects",
          });
        }

        const businessId = typeof existing.business_id === "string"
          ? new ObjectId(existing.business_id)
          : existing.business_id;

        // await BusinessModel.clearAllowedCollabosrators(businessId);

        await ProjectModel.collection().updateMany(
          { business_id: businessId },
          { $set: { allowed_collaborators: [], updated_at: new Date() } }
        );
      }

      if (req.body.status === "reprioritizing") {
        if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
          return res.status(403).json({
            error: "Only company_admin or super_admin can set project to reprioritizing",
          });
        }

        const allowedCollabs = req.body.allowed_collaborators || [];
        if (!Array.isArray(allowedCollabs)) {
          return res.status(400).json({ error: "allowed_collaborators must be an array of user IDs" });
        }

        await ProjectModel.update(id, {
          allowed_collaborators: allowedCollabs,
          updated_at: new Date()
        });
      }

      const business = await BusinessModel.findById(existing.business_id);
      if (!business)
        return res.status(404).json({ error: "Parent business not found" });

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(
        (id) => id.toString() === req.user._id.toString()
      );

      const bStatus = (business.status || "").toLowerCase();
      const pStatus = (existing.status || "").toLowerCase();

      const permissions = getProjectPermissions({
        businessStatus: bStatus,
        isOwner,
        isCollaborator,
        isAdmin,
      });

      const isInAllowedCollabs = Array.isArray(existing.allowed_collaborators) &&
        existing.allowed_collaborators.some(id => id.toString() === req.user._id.toString());

      let canEditProject = false;

      if (pStatus === "launched" || bStatus === "launched") {
        canEditProject = isAdmin || isInAllowedCollabs;
      } else if (pStatus === "reprioritizing" || bStatus === "reprioritizing") {
        canEditProject = isAdmin || isInAllowedCollabs;
      } else {
        canEditProject = permissions.canEdit;
      }

      if (!canEditProject) {
        return res.status(403).json({
          error: `You cannot edit this project in its current status`,
        });
      }

      // Redundant case-sensitive check removed. Status is normalized and validated later.

      const updateData = {
        updated_at: new Date(),
      };

      if (Array.isArray(req.body.allowed_collaborators)) {
        updateData.allowed_collaborators = req.body.allowed_collaborators;
      }

      if (req.body.project_name !== undefined) {
        const name = normalizeString(req.body.project_name).trim();
        if (!name) {
          return res.status(400).json({ error: "Project name cannot be empty" });
        }
        updateData.project_name = name;
      }

      if (req.body.project_type !== undefined) {
        const type = normalizeString(req.body.project_type).trim();
        if (type && !PROJECT_TYPES.includes(type)) {
          return res.status(400).json({
            error: `project_type must be one of ${PROJECT_TYPES.join(", ")}`,
          });
        }
        updateData.project_type = type || DEFAULT_PROJECT_TYPE;
      }

      if (req.body.description !== undefined)
        updateData.description = normalizeString(req.body.description);

      if (req.body.why_this_matters !== undefined)
        updateData.why_this_matters = normalizeString(
          req.body.why_this_matters
        );

      if (req.body.strategic_decision !== undefined)
        updateData.strategic_decision = normalizeString(req.body.strategic_decision);

      if (req.body.accountable_owner !== undefined)
        updateData.accountable_owner = normalizeString(req.body.accountable_owner);

      if (req.body.key_assumptions !== undefined) {
        if (req.body.key_assumptions === "" || req.body.key_assumptions === null) {
          updateData.key_assumptions = [];
        } else if (!Array.isArray(req.body.key_assumptions)) {
          return res.status(400).json({ error: "key_assumptions must be an array" });
        } else {
          updateData.key_assumptions = req.body.key_assumptions.slice(0, 3).map(normalizeString);
        }
      }

      if (req.body.success_criteria !== undefined)
        updateData.success_criteria = normalizeString(req.body.success_criteria);

      if (req.body.kill_criteria !== undefined)
        updateData.kill_criteria = normalizeString(req.body.kill_criteria);

      if (req.body.review_cadence !== undefined)
        updateData.review_cadence = normalizeString(req.body.review_cadence);

      if (req.body.status !== undefined) {
        const val = req.body.status;
        if (val === "" || val === null) {
          updateData.status = existing.status;
        } else {
          const trimmed = String(val).trim();
          const found = VALID_STATUS.find(s => s.toLowerCase() === trimmed.toLowerCase());

          if (!found) {
            return res.status(400).json({ error: "Invalid status value" });
          }

          updateData.status = found;
        }
      }


      if (req.body.impact !== undefined)
        updateData.impact = normalizeString(req.body.impact);

      if (req.body.effort !== undefined)
        updateData.effort = normalizeString(req.body.effort);

      if (req.body.risk !== undefined)
        updateData.risk = normalizeString(req.body.risk);

      if (req.body.strategic_theme !== undefined)
        updateData.strategic_theme = normalizeString(req.body.strategic_theme);

      if (req.body.dependencies !== undefined)
        updateData.dependencies = normalizeString(req.body.dependencies);

      if (req.body.constraints_non_negotiables !== undefined || req.body.high_level_requirements !== undefined)
        updateData.high_level_requirements = normalizeString(
          req.body.constraints_non_negotiables || req.body.high_level_requirements
        );

      if (req.body.explicitly_out_of_scope !== undefined || req.body.scope_definition !== undefined)
        updateData.scope_definition = normalizeString(
          req.body.explicitly_out_of_scope || req.body.scope_definition
        );

      if (req.body.expected_outcome !== undefined)
        updateData.expected_outcome = normalizeString(
          req.body.expected_outcome
        );

      if (req.body.success_metrics !== undefined)
        updateData.success_metrics = normalizeString(req.body.success_metrics);

      if (req.body.estimated_timeline !== undefined)
        updateData.estimated_timeline = normalizeString(
          req.body.estimated_timeline
        );

      //budget_estimate must ALWAYS be a string (never null)
      if (req.body.budget_estimate !== undefined) {
        const budget = req.body.budget_estimate;
        if (budget === "" || budget === null || budget === undefined) {
          updateData.budget_estimate = "";
        } else {
          updateData.budget_estimate = String(budget).trim();
        }
      }

      if (req.body.learning_state !== undefined) {
        updateData.learning_state = normalizeString(req.body.learning_state);
      }

      if (req.body.last_reviewed !== undefined) {
        const lr = req.body.last_reviewed;
        updateData.last_reviewed = (lr === null || lr === "") ? null : new Date(lr);
      }

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;

      await ProjectModel.update(id, updateData);

      const updated = await ProjectModel.findById(id);
      const [project] = await ProjectModel.populateCreatedBy(updated);

      res.json({
        message: "Project updated successfully",
        project,
      });
    } catch (err) {
      console.error("PROJECT UPDATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async rankProjects(req, res) {
    try {
      const { business_id, projects } = req.body;
      const user_id = req.user._id;

      if (!ObjectId.isValid(business_id) || !Array.isArray(projects)) {
        return res.status(400).json({ error: "Invalid request data" });
      }

      if (projects.length === 0) {
        return res.status(400).json({ error: "Projects array cannot be empty" });
      }

      // validate 
      for (const p of projects) {
        if (!ObjectId.isValid(p.project_id)) {
          return res.status(400).json({ error: "Invalid project_id" });
        }
        if (typeof p.rank !== "number" || p.rank < 1) {
          return res.status(400).json({ error: "Invalid rank value" });
        }
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const isAdmin = ["company_admin", "super_admin"].includes(req.user.role.role_name);

      if (business.status === "reprioritizing") {
        if (!isAdmin) {
          const allowed = await BusinessModel.getAllowedRankingCollaborators(business_id);

          const allowedIds = allowed.map(uid => uid.toString());

          if (!allowedIds.includes(user_id.toString())) {
            return res.status(403).json({
              error: "You are not allowed to rank during reprioritizing",
            });
          }
        }
      }

      const allProjects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id),

      });

      const existingRankings = await ProjectRankingModel.collection()
        .find({
          user_id: new ObjectId(user_id),
          business_id: new ObjectId(business_id)
        })
        .toArray();

      const rankMap = {};
      const rationalMap = {};
      projects.forEach(p => {
        rankMap[p.project_id] = p.rank;
        rationalMap[p.project_id] = p.rationals || "";
      });

      const rankingDocs = allProjects.map(project => {
        const projIdStr = project._id.toString();
        const existing = existingRankings.find(r => r.project_id.toString() === projIdStr);
        const isLocked = existing?.locked || false;

        return {
          user_id: new ObjectId(user_id),
          business_id: new ObjectId(business_id),
          project_id: project._id,
          rank: isLocked ? existing.rank : rankMap[projIdStr] || null,
          rationals: isLocked ? existing.rationals : rationalMap[projIdStr] || "",
          locked: existing?.locked || false,
        };
      });

      await ProjectRankingModel.bulkUpsert(rankingDocs);

      // updated rankings for response
      const rankedProjects =
        await ProjectRankingModel.findByUserAndBusiness(user_id, business_id);

      const lockedProjects = rankedProjects.filter(r => r.locked).map(r => r.project_id);

      res.json({
        user_id,
        business_id,
        projects: rankedProjects.map(r => ({
          project_id: r.project_id,
          rank: r.rank,
          rationals: r.rationals,
          locked: r.locked || false,
        })),
        locked_projects: lockedProjects,
        message: lockedProjects.length ? "Could not update locked project-ranks"
          : "Project ranks updated successfully"
      });
    } catch (err) {
      console.error("Rank Projects err:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async getRankings(req, res) {
    try {
      const { user_id } = req.params;
      const { business_id } = req.query;

      if (!ObjectId.isValid(user_id)) {
        return res.status(400).json({ error: "Invalid user_id" });
      }

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const rankings = await ProjectRankingModel.findByUserAndBusiness(
        user_id,
        business_id
      );
      const business = await BusinessModel.findById(business_id);

      let ranking_lock_summary = {
        locked_users_count: 0,
        total_users: 0,
        locked_users: [],
      };

      if (business) {
        const collaboratorIds = (business.collaborators || []).map(id => id.toString());
        const uniqueCollaboratorIds = [...new Set(collaboratorIds)];
        const db = getDB();

        const users = await db.collection("users").find({
          _id: { $in: uniqueCollaboratorIds.map(id => new ObjectId(id)) }
        }).toArray();

        const nonAdminUsers = users.filter(u => !ADMIN_ROLES.includes(u.role_name));
        const nonAdminUserIds = nonAdminUsers.map(u => u._id);

        const lockedRankings = await ProjectRankingModel.collection()
          .find({
            business_id: new ObjectId(business_id),
            locked: true,
            user_id: { $in: nonAdminUserIds }
          })
          .toArray();

        const lockedUserIds = [...new Set(lockedRankings.map(r => r.user_id.toString()))];

        const lockedUsers = nonAdminUsers
          .filter(u => lockedUserIds.includes(u._id.toString()))
          .map(u => ({
            user_id: u._id,
            name: u.name,
            email: u.email,
          }));

        ranking_lock_summary = {
          total_users: nonAdminUsers.length,
          locked_users_count: lockedUsers.length,
          locked_users: lockedUsers,
        };
      }

      if (rankings.length === 0) {
        return res.json({
          user_id,
          business_id,
          business_status: business?.status || null,
          business_access_mode: business?.access_mode || null,
          projects: [],
          ranking_lock_summary,
        });
      }

      const projectIds = rankings.map(r => r.project_id);
      const projects = await ProjectModel.findAll({
        _id: { $in: projectIds },
      });

      const projectMap = {};
      projects.forEach(p => {
        projectMap[p._id.toString()] = p;
      });

      const ranked = [];
      const unranked = [];

      rankings.forEach(r => {
        const project = projectMap[r.project_id.toString()];
        if (!project) return;

        if (r.rank !== null) {
          ranked.push({ ranking: r, project });
        } else {
          unranked.push({ ranking: r, project });
        }
      });

      ranked.sort((a, b) => a.ranking.rank - b.ranking.rank);
      unranked.sort(
        (a, b) =>
          new Date(a.project.created_at) - new Date(b.project.created_at)
      );

      const ordered = [...ranked, ...unranked];

      const responseProjects = ordered.map(({ ranking, project }) => ({
        project_id: project._id,
        project_name: project.project_name,
        rank: ranking.rank,
        rationals: ranking.rationals || "",
        locked: ranking.locked || false,
      }));

      res.json({
        user_id,
        business_id,
        business_status: business?.status || null,
        business_access_mode: business?.access_mode || null,
        projects: responseProjects,
        ranking_lock_summary,
      });

    } catch (err) {
      console.error("err:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async getAdminRankings(req, res) {
    try {
      const { business_id, admin_user_id } = req.query;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      if (!ObjectId.isValid(admin_user_id)) {
        return res.status(400).json({ error: "Invalid admin_user_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const rankings = await ProjectRankingModel.findByUserAndBusiness(
        admin_user_id,
        business_id
      );

      const projects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id),
      });

      const rankMap = {};
      rankings.forEach(r => {
        rankMap[r.project_id.toString()] = r.rank;
      });

      const ranked = [];
      const unranked = [];

      projects.forEach(p => {
        const rank = rankMap[p._id.toString()] ?? null;
        const item = {
          admin_user_id: admin_user_id,
          business_id,
          project_id: p._id,
          rank,
          created_at: p.created_at,
        };

        if (rank !== null) {
          ranked.push(item);
        } else {
          unranked.push(item);
        }
      });

      ranked.sort((a, b) => a.rank - b.rank);
      unranked.sort(
        (a, b) => new Date(a.created_at) - new Date(b.created_at)
      );

      const response = [...ranked, ...unranked].map(({ created_at, ...rest }) => rest);

      res.json({
        admin_user_id: admin_user_id,
        business_id,
        projects: response,
      });

    } catch (err) {
      console.error("ADMIN RANKINGS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async lockRank(req, res) {
    try {
      const user_id = req.user._id;
      const { project_id } = req.query;

      if (!ObjectId.isValid(project_id)) {
        return res.status(400).json({ error: "Invalid project_id" });
      }

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      if (isAdmin) {
        return res.status(403).json({ error: "Admins cannot lock ranks" });
      }

      const alreadyLocked = await ProjectRankingModel.isLocked(
        user_id,
        project_id
      );

      if (alreadyLocked) {
        return res.status(409).json({
          error: "Project ranking is already locked",
          project_id,
        });
      }

      await ProjectRankingModel.lockRank(user_id, project_id);

      res.json({ message: "Rank locked successfully", project_id });
    } catch (err) {
      console.error("Lock rank err:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async delete(req, res) {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id))
        return res.status(400).json({ error: "Invalid ID" });

      const found = await ProjectModel.findById(id);
      if (!found) return res.status(404).json({ error: "Not found" });

      const tierName = await TierService.getUserTier(req.user._id);
      if (!await TierService.canCreateProject(tierName)) {
        return res.status(403).json({
          error: `Project deletion is locked for ${tierName} plan. Upgrade to Advanced to execute your strategy.`
        });
      }

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({
          error: "Admin access required to delete project",
        });
      }

      await ProjectModel.update(id, {
        status: "Killed",
        updated_at: new Date()
      });

      res.json({
        message: "Project killed successfully",
        killed: { id, project_name: found.project_name },
      });
    } catch (err) {
      console.error("PROJECT DELETE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  };

  static async changeStatus(req, res) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const tierName = await TierService.getUserTier(req.user._id);
      if (!await TierService.canCreateProject(tierName)) {
        return res.status(403).json({
          error: `Project status change is locked for ${tierName} plan. Upgrade to Advanced to execute your strategy.`
        });
      }

      const VALID_STATUS = ["draft", "prioritizing", "prioritized", "launched", "reprioritizing"];
      const ADMIN_ROLES = ["company_admin", "super_admin"];

      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({
          error: "Only company_admin or super_admin can change project status",
        });
      }

      const project = await ProjectModel.findById(id);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }


      if (status === "launched") {
        const businessId =
          typeof project.business_id === "string"
            ? new ObjectId(project.business_id)
            : project.business_id;

        console.log("Clearing allowed_collaborators for business:", businessId);

        await ProjectModel.clearAllowedCollaborators(project._id);

        await ProjectModel.collection().updateMany(
          { business_id: businessId },
          { $set: { allowed_collaborators: [], updated_at: new Date() } }
        );
      }

      await ProjectModel.collection().updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updated_at: new Date() } }
      );

      res.json({
        message: "Project status updated successfully",
        project_id: id,
        new_status: status,
      });
    } catch (err) {
      console.error("PROJECT STATUS UPDATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }


  static async grantEditAccess(req, res) {
    try {
      const { scope, business_id, project_id } = req.body;

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({ error: "Admin access required" });
      }

      if (!["projectEdit", "reRanking"].includes(scope)) {
        return res.status(400).json({ error: "Invalid scope" });
      }

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      if (scope === "projectEdit") {
        if (!ObjectId.isValid(project_id)) {
          return res.status(400).json({ error: "Invalid project_id" });
        }

        const project = await ProjectModel.findById(project_id);
        if (!project) {
          return res.status(404).json({ error: "Project not found" });
        }

        if (project.business_id.toString() !== business_id) {
          return res.status(400).json({ error: "Project does not belong to business" });
        }
        return res.json({
          scope: "project",
          message: "Project edit access will be granted",
          project_id,
          current_status: project.status,
        });
      }

      if (scope === "reRanking") {
        await ProjectRankingModel.unlockRankingByBusiness(business_id);
        await BusinessModel.clearAllowedRankingCollaborators(business_id);

        return res.json({
          scope: "business",
          message: "Business re-ranking access granted",
          business_id,
          current_status: business.status,
        });
      }

    } catch (err) {
      console.error("EDIT MODE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async checkUserAccess(req, res) {
    try {
      const { business_id, project_id } = req.query;
      const user_id = req.user._id;

      console.log("checkUserAccess called with:", { business_id, project_id, user_id: user_id.toString() });

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

      let hasRerankAccess = false;
      try {
        const allowedRankingCollabs = await BusinessModel.getAllowedRankingCollaborators(business_id);
        hasRerankAccess = isAdmin ||
          allowedRankingCollabs.some(id => id.toString() === user_id.toString());
      } catch (err) {
        console.error("Error checking rerank access:", err);
        hasRerankAccess = isAdmin;
      }

      let hasProjectEditAccess = false;

      if (project_id && project_id !== 'null' && project_id !== 'undefined') {
        try {
          const projectObjId = new ObjectId(project_id);
          const project = await ProjectModel.findById(projectObjId);

          if (project) {
            const isInAllowedCollabs = Array.isArray(project.allowed_collaborators) &&
              project.allowed_collaborators.some(id => id.toString() === user_id.toString());

            hasProjectEditAccess = isAdmin || isInAllowedCollabs;
          }
        } catch (err) {
          console.error("Error checking project access for", project_id, ":", err);
          hasProjectEditAccess = false;
        }
      }

      const response = {
        business_id,
        project_id: project_id || null,
        business_status: business.status,
        has_rerank_access: hasRerankAccess,
        has_project_edit_access: hasProjectEditAccess,
      };
      res.json(response);
    } catch (err) {
      console.error("CHECK ACCESS ERR:", err);
      res.status(500).json({ error: "Server error", details: err.message });
    }
  }

  static async getGrantedAccess(req, res) {
    try {
      const { business_id } = req.query;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const rerankingCollaboratorIds = await BusinessModel.getAllowedRankingCollaborators(business_id);

      const projects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id),
      });

      const projectEditUserIds = new Set();
      const projectAccessMap = {};

      projects.forEach(project => {
        if (Array.isArray(project.allowed_collaborators)) {
          project.allowed_collaborators.forEach(userId => {
            const userIdStr = userId.toString();
            projectEditUserIds.add(userIdStr);

            if (!projectAccessMap[userIdStr]) {
              projectAccessMap[userIdStr] = [];
            }
            projectAccessMap[userIdStr].push({
              project_id: project._id,
              project_name: project.project_name,
              status: project.status,
            });
          });
        }
      });

      const allUserIds = new Set([
        ...rerankingCollaboratorIds.map(id => id.toString()),
        ...Array.from(projectEditUserIds)
      ]);

      const db = getDB();
      const users = await db.collection("users").find({
        _id: { $in: Array.from(allUserIds).map(id => new ObjectId(id)) }
      }).toArray();

      const accessList = users.map(user => {
        const userIdStr = user._id.toString();
        const hasRerankAccess = rerankingCollaboratorIds.some(id => id.toString() === userIdStr);
        const projectAccess = projectAccessMap[userIdStr] || [];

        return {
          user_id: user._id,
          user_name: user.name,
          user_email: user.email,
          role_name: user.role_name,
          has_rerank_access: hasRerankAccess,
          has_project_edit_access: projectAccess.length > 0,
          projects_with_access: projectAccess,
        };
      });

      res.json({
        business_id,
        business_name: business.business_name,
        business_status: business.status,
        total_users_with_access: accessList.length,
        access_list: accessList,
      });

    } catch (err) {
      console.error("GET GRANTED ACCESS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async revokeAccess(req, res) {
    try {
      const { business_id, user_id, access_type } = req.body;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      if (!ObjectId.isValid(user_id)) {
        return res.status(400).json({ error: "Invalid user_id" });
      }

      if (!["rerank", "project_edit", "all"].includes(access_type)) {
        return res.status(400).json({ error: "Invalid access_type. Must be 'rerank', 'project_edit', or 'all'" });
      }

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      let revokedAccess = [];

      // Revoke reranking access
      if (access_type === "rerank" || access_type === "all") {
        const allowedRankingCollaborators = await BusinessModel.getAllowedRankingCollaborators(business_id);
        const filteredCollaborators = allowedRankingCollaborators.filter(
          id => id.toString() !== user_id.toString()
        );

        await BusinessModel.collection().updateOne(
          { _id: new ObjectId(business_id) },
          { $set: { allowed_ranking_collaborators: filteredCollaborators } }
        );

        revokedAccess.push("rerank");
      }

      // Revoke project edit access
      if (access_type === "project_edit" || access_type === "all") {
        const projects = await ProjectModel.findAll({
          business_id: new ObjectId(business_id),
        });

        const updatePromises = projects.map(project => {
          if (Array.isArray(project.allowed_collaborators)) {
            const filteredCollaborators = project.allowed_collaborators.filter(
              id => id.toString() !== user_id.toString()
            );

            return ProjectModel.update(project._id.toString(), {
              allowed_collaborators: filteredCollaborators,
              updated_at: new Date()
            });
          }
          return Promise.resolve();
        });

        await Promise.all(updatePromises);
        revokedAccess.push("project_edit");
      }

      res.json({
        message: "Access revoked successfully",
        business_id,
        user_id,
        revoked_access: revokedAccess,
      });

    } catch (err) {
      console.error("REVOKE ACCESS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
  static async saveAIRankings(req, res) {
    try {
      const { business_id, ai_rankings, model_version, metadata } = req.body;

      // Validate request
      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      if (!Array.isArray(ai_rankings) || ai_rankings.length === 0) {
        return res.status(400).json({
          error: "ai_rankings must be a non-empty array"
        });
      }

      // Verify admin access
      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({
          error: "Only admins can save AI rankings",
        });
      }

      // Verify business exists
      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Validate all projects belong to this business
      const projectIds = ai_rankings.map(r => new ObjectId(r.project_id));
      const projects = await ProjectModel.findAll({
        _id: { $in: projectIds },
        business_id: new ObjectId(business_id)
      });

      if (projects.length !== ai_rankings.length) {
        return res.status(400).json({
          error: "Some project IDs are invalid or don't belong to this business"
        });
      }

      // Validate ranks are sequential and unique
      const ranks = ai_rankings.map(r => r.rank).sort((a, b) => a - b);
      const expectedRanks = Array.from({ length: ranks.length }, (_, i) => i + 1);
      const ranksValid = ranks.every((rank, idx) => rank === expectedRanks[idx]);

      if (!ranksValid) {
        return res.status(400).json({
          error: "Ranks must be sequential starting from 1 with no duplicates"
        });
      }

      // Save AI ranking session at business level
      await BusinessModel.saveAIRankingSession(business_id, {
        admin_id: req.user._id,
        model_version: model_version || "v1.0",
        total_projects: ai_rankings.length,
        metadata: metadata || {}
      });

      // Bulk update AI ranks on projects
      const bulkResult = await ProjectModel.bulkUpdateAIRanks(ai_rankings);

      res.json({
        message: "AI rankings saved successfully",
        business_id,
        projects_updated: bulkResult.modifiedCount,
        rankings_applied: ai_rankings.length,
        model_version: model_version || "v1.0"
      });

    } catch (err) {
      console.error("SAVE AI RANKINGS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async getAIRankings(req, res) {
    try {
      const { business_id } = req.query;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Get AI ranking session info
      const rankingSession = await BusinessModel.getAIRankingSession(business_id);

      // Get all projects with their AI ranks
      const projects = await ProjectModel.getProjectsWithAIRanks(business_id);

      // Populate created_by field
      const populatedProjects = await ProjectModel.populateCreatedBy(projects);

      const response = {
        business_id,
        business_name: business.business_name,
        ranking_session: rankingSession,
        projects: populatedProjects.map(p => ({
          project_id: p._id,
          project_name: p.project_name,
          ai_rank: p.ai_rank,
          ai_rank_score: p.ai_rank_score || null,
          ai_rank_factors: p.ai_rank_factors || {},
          created_by: p.created_by,
          status: p.status
        }))
      };

      res.json(response);

    } catch (err) {
      console.error("GET AI RANKINGS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
  static async getConsensusAnalysis(req, res) {
    try {
      const { business_id } = req.query;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Get all projects with AI rankings
      const projects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id),
        ai_rank: { $exists: true, $ne: null }
      });

      if (projects.length === 0) {
        return res.json({
          business_id,
          consensus_data: [],
          message: "No AI rankings found for this business"
        });
      }

      // Get all collaborator rankings
      const db = getDB();
      const allRankings = await db.collection("project_rankings")
        .find({
          business_id: new ObjectId(business_id)
        })
        .toArray();

      // Get all non-admin collaborators
      const collaboratorIds = (business.collaborators || []).map(id => id.toString());
      const users = await db.collection("users").find({
        _id: { $in: collaboratorIds.map(id => new ObjectId(id)) }
      }).toArray();

      const nonAdminUserIds = users
        .filter(u => !ADMIN_ROLES.includes(u.role_name))
        .map(u => u._id.toString());

      // Calculate consensus for each project
      const consensusData = projects.map(project => {
        const projectId = project._id.toString();
        const aiRank = project.ai_rank;

        // Get all collaborator rankings for this project (excluding admins)
        const projectRankings = allRankings.filter(r =>
          r.project_id.toString() === projectId &&
          nonAdminUserIds.includes(r.user_id.toString()) &&
          r.rank !== null &&
          r.rank !== undefined
        );

        const totalCollaborators = projectRankings.length;

        if (totalCollaborators === 0) {
          return {
            project_id: project._id,
            project_name: project.project_name,
            ai_rank: aiRank,
            consensus_score: null,
            consensus_level: "no_data",
            total_collaborators: 0,
            agreeing_collaborators: 0,
            agreement_percentage: 0,
            collaborator_ranks: []
          };
        }

        // Count how many collaborators ranked within ±1 of AI rank
        // You can adjust the tolerance (currently ±1 means exact match or 1 position difference)
        const tolerance = 1;
        const agreeingCollaborators = projectRankings.filter(r =>
          Math.abs(r.rank - aiRank) <= tolerance
        ).length;

        const agreementPercentage = (agreeingCollaborators / totalCollaborators) * 100;

        // Determine consensus level
        let consensusLevel;
        let consensusScore;
        if (agreementPercentage >= 80) {
          consensusLevel = "high";
          consensusScore = "green";
        } else if (agreementPercentage >= 50) {
          consensusLevel = "medium";
          consensusScore = "yellow";
        } else {
          consensusLevel = "low";
          consensusScore = "red";
        }

        return {
          project_id: project._id,
          project_name: project.project_name,
          ai_rank: aiRank,
          ai_rank_score: project.ai_rank_score || null,
          consensus_score: consensusScore,
          consensus_level: consensusLevel,
          total_collaborators: totalCollaborators,
          agreeing_collaborators: agreeingCollaborators,
          agreement_percentage: Math.round(agreementPercentage),
          collaborator_ranks: projectRankings.map(r => ({
            user_id: r.user_id,
            rank: r.rank,
            matches_ai: Math.abs(r.rank - aiRank) <= tolerance
          }))
        };
      });

      // Sort by AI rank
      consensusData.sort((a, b) => a.ai_rank - b.ai_rank);

      res.json({
        business_id,
        total_projects: consensusData.length,
        consensus_summary: {
          high_consensus: consensusData.filter(d => d.consensus_level === "high").length,
          medium_consensus: consensusData.filter(d => d.consensus_level === "medium").length,
          low_consensus: consensusData.filter(d => d.consensus_level === "low").length,
          no_data: consensusData.filter(d => d.consensus_level === "no_data").length
        },
        consensus_data: consensusData
      });

    } catch (err) {
      console.error("GET CONSENSUS ANALYSIS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
  static async getCollaboratorConsensus(req, res) {
    try {
      const { business_id } = req.query;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      // Get all projects for this business
      const projects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id)
      });

      if (projects.length === 0) {
        return res.json({
          business_id,
          consensus_data: [],
          message: "No projects found for this business"
        });
      }

      // Get all collaborator rankings
      const db = getDB();
      const allRankings = await db.collection("project_rankings")
        .find({
          business_id: new ObjectId(business_id)
        })
        .toArray();

      // Get all non-admin collaborators
      const collaboratorIds = (business.collaborators || []).map(id => id.toString());
      const users = await db.collection("users").find({
        _id: { $in: collaboratorIds.map(id => new ObjectId(id)) }
      }).toArray();

      const nonAdminUsers = users.filter(u => !ADMIN_ROLES.includes(u.role_name));
      const nonAdminUserIds = nonAdminUsers.map(u => u._id.toString());

      // Create user map for names
      const userMap = {};
      nonAdminUsers.forEach(u => {
        userMap[u._id.toString()] = u.name;
      });

      // Calculate consensus for each project
      const consensusData = projects.map(project => {
        const projectId = project._id.toString();

        // Get all collaborator rankings for this project (excluding admins)
        const projectRankings = allRankings.filter(r =>
          r.project_id.toString() === projectId &&
          nonAdminUserIds.includes(r.user_id.toString()) &&
          r.rank !== null &&
          r.rank !== undefined
        );

        const totalCollaborators = projectRankings.length;

        if (totalCollaborators === 0) {
          return {
            project_id: project._id,
            project_name: project.project_name,
            average_rank: null,
            consensus_score: null,
            consensus_level: "no_data",
            total_collaborators: 0,
            rank_variance: 0,
            collaborator_rankings: []
          };
        }

        // Calculate average rank
        const rankSum = projectRankings.reduce((sum, r) => sum + r.rank, 0);
        const averageRank = rankSum / totalCollaborators;

        // Calculate variance to determine consensus
        const variance = projectRankings.reduce((sum, r) => {
          return sum + Math.pow(r.rank - averageRank, 2);
        }, 0) / totalCollaborators;

        const standardDeviation = Math.sqrt(variance);

        // Determine consensus level based on standard deviation
        let consensusLevel;
        let consensusScore;

        // Lower standard deviation = higher agreement
        if (standardDeviation <= 2) {
          consensusLevel = "high";
          consensusScore = "green";
        } else if (standardDeviation <= 4) {
          consensusLevel = "medium";
          consensusScore = "yellow";
        } else {
          consensusLevel = "low";
          consensusScore = "red";
        }

        // Format collaborator rankings with names and rationales
        const collaboratorRankings = projectRankings.map(r => ({
          user_id: r.user_id,
          user_name: userMap[r.user_id.toString()] || "Unknown",
          rank: r.rank,
          rationale: r.rationals || "",
          deviation_from_average: Math.abs(r.rank - averageRank).toFixed(1)
        })).sort((a, b) => a.rank - b.rank);

        return {
          project_id: project._id,
          project_name: project.project_name,
          average_rank: Math.round(averageRank * 10) / 10, // Round to 1 decimal
          consensus_score: consensusScore,
          consensus_level: consensusLevel,
          total_collaborators: totalCollaborators,
          rank_variance: Math.round(variance * 10) / 10,
          standard_deviation: Math.round(standardDeviation * 10) / 10,
          collaborator_rankings: collaboratorRankings
        };
      });

      // Sort by average rank
      consensusData.sort((a, b) => {
        if (a.average_rank === null) return 1;
        if (b.average_rank === null) return -1;
        return a.average_rank - b.average_rank;
      });

      res.json({
        business_id,
        total_projects: consensusData.length,
        consensus_summary: {
          high_consensus: consensusData.filter(d => d.consensus_level === "high").length,
          medium_consensus: consensusData.filter(d => d.consensus_level === "medium").length,
          low_consensus: consensusData.filter(d => d.consensus_level === "low").length,
          no_data: consensusData.filter(d => d.consensus_level === "no_data").length
        },
        consensus_data: consensusData
      });

    } catch (err) {
      console.error("GET COLLABORATOR CONSENSUS ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = ProjectController;
