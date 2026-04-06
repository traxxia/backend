const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");
const ProjectRankingModel = require("../models/projectRankingModel");
const UserModel = require("../models/userModel")
const DecisionLogModel = require("../models/decisionLogModel");
const { getDB } = require("../config/database");
const TierService = require("../services/tierService");

const {
  PROJECT_STATES,
  PROJECT_LAUNCH_STATUS,
  ALLOWED_PHASES,
} = require("../config/constants");

const VALID_STATUS = Object.values(PROJECT_STATES);
const ADMIN_ROLES = ["company_admin", "super_admin"];
const PROJECT_TYPES = ["immediate action", "short term initiative", "long term shift"];
const DEFAULT_PROJECT_TYPE = "immediate action";
const { calculateNextReviewDate, isProjectStale } = require("../utils/helpers");



// State transition validation based on Launch Status and Functional State
function validateStateTransition(currentStatus, currentLaunchStatus, targetStatus, isAdmin = false) {
  const status = (currentStatus || "").toLowerCase();
  const launchStatus = (currentLaunchStatus || PROJECT_LAUNCH_STATUS.UNLAUNCHED).toLowerCase();
  const target = (targetStatus || "").toLowerCase();

  // If already Launched, cannot return to Unlaunched states (Draft)
  if (launchStatus === PROJECT_LAUNCH_STATUS.LAUNCHED && target === PROJECT_STATES.DRAFT) {
    return { isValid: false, error: "Once a project moves to 'Launched', it cannot return to 'Draft' (Unlaunched)." };
  }

  // Terminal states cannot transition to any other state (Except Killed which admins can edit/move)
  if (status === PROJECT_STATES.COMPLETED || status === PROJECT_STATES.SCALED) {
    return { isValid: false, error: `Project is in a terminal state (${status}) and cannot be moved.` };
  }

  if (status === PROJECT_STATES.KILLED && !isAdmin) {
    return { isValid: false, error: "Project is in a terminal state (killed) and cannot be moved." };
  }

  // Transitions from Killed (Admins Only)
  if (status === PROJECT_STATES.KILLED && isAdmin) {
    // If it was unlaunched, it can only move to Draft or Active (if being launched)
    if (launchStatus === PROJECT_LAUNCH_STATUS.UNLAUNCHED) {
      if (![PROJECT_STATES.DRAFT, PROJECT_STATES.ACTIVE].includes(target)) {
        return { isValid: false, error: `Invalid transition from Killed to ${target} for unlaunched project.` };
      }
    } else {
      // If launched, it can move to any active state
      const validStates = [PROJECT_STATES.ACTIVE, PROJECT_STATES.AT_RISK, PROJECT_STATES.PAUSED];
      if (!validStates.includes(target) && target !== PROJECT_STATES.KILLED) {
        return { isValid: false, error: `Invalid transition from Killed to ${target} for launched project.` };
      }
    }
  }

  // Transitions from Draft
  if (status === PROJECT_STATES.DRAFT) {
    // Draft -> Active is EXCLUSIVELY handled via the "Launch" mechanism
    if (target === PROJECT_STATES.ACTIVE) {
      return { isValid: false, error: "Projects can only move to 'Active' through the Launch mechanism after being ranked." };
    }
    // Draft -> Killed (Unlaunched) or Draft -> Draft
    const validDraftTransitions = [PROJECT_STATES.DRAFT, PROJECT_STATES.KILLED];
    if (!validDraftTransitions.includes(target)) {
      return { isValid: false, error: `Invalid transition from Draft to ${target}.` };
    }
  }

  // Transitions from Active
  if (status === PROJECT_STATES.ACTIVE) {
    const validActiveTransitions = [
      PROJECT_STATES.ACTIVE,
      PROJECT_STATES.AT_RISK,
      PROJECT_STATES.PAUSED,
      PROJECT_STATES.COMPLETED,
      PROJECT_STATES.KILLED,
      PROJECT_STATES.SCALED
    ];
    if (!validActiveTransitions.includes(target)) {
      return { isValid: false, error: `Invalid transition from Active to ${target}.` };
    }
  }

  // Transitions from At Risk
  if (status === PROJECT_STATES.AT_RISK) {
    const validAtRiskTransitions = [
      PROJECT_STATES.AT_RISK,
      PROJECT_STATES.ACTIVE,
      PROJECT_STATES.PAUSED,
      PROJECT_STATES.KILLED
    ];
    if (!validAtRiskTransitions.includes(target)) {
      return { isValid: false, error: `Invalid transition from At Risk to ${target}.` };
    }
  }

  // Transitions from Paused
  if (status === PROJECT_STATES.PAUSED) {
    const validPausedTransitions = [PROJECT_STATES.PAUSED, PROJECT_STATES.ACTIVE, PROJECT_STATES.KILLED];
    if (!validPausedTransitions.includes(target)) {
      return { isValid: false, error: `Invalid transition from Paused to ${target}.` };
    }
  }

  return { isValid: true };
}

// Permission matrix for ALL project actions
function getProjectPermissions({
  projectStatus,
  isOwner,
  isCollaborator,
  isAdmin,
  isAllowedCollaborator,
  userRole,
}) {
  const status = (projectStatus || "").toLowerCase();

  // Viewer role is ALWAYS read-only
  if (userRole === "viewer") {
    return { canCreate: false, canEdit: false };
  }

  const canModify = isAdmin || isCollaborator || isOwner;

  switch (status) {
    case PROJECT_STATES.DRAFT:
      return {
        canCreate: canModify,
        canEdit: canModify,
      };
    case PROJECT_STATES.ACTIVE:
    case PROJECT_STATES.AT_RISK:
    case PROJECT_STATES.PAUSED:
      return {
        canCreate: false,
        canEdit: isAdmin || isAllowedCollaborator || isOwner || isCollaborator, // Enabled editing for owners/collaborators in launched states for visual indicators
      };

    case PROJECT_STATES.COMPLETED:
    case PROJECT_STATES.KILLED:
    case PROJECT_STATES.SCALED:
      return {
        canCreate: false,
        canEdit: false, // Terminal states are locked for EVERYONE (including admins)
      };

    default:
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
  static _resolveOwner(project, ownerNameMap = {}, bizOwnerFallbackMap = {}) {
    let ownerName = project.accountable_owner;

    if (project.accountable_owner_id && ownerNameMap[project.accountable_owner_id.toString()]) {
      ownerName = ownerNameMap[project.accountable_owner_id.toString()];
    }

    if (!ownerName || ownerName === "Unassigned") {
      const fallingBackToBizOwner = bizOwnerFallbackMap[project.business_id?.toString()];
      ownerName = fallingBackToBizOwner || project.created_by;
    }

    if (!ownerName || ownerName === "Unassigned") {
      ownerName = project.created_by || "Unassigned";
    }

    if (ownerName === "User" || ownerName === "Unknown User") {
      const fallback = bizOwnerFallbackMap[project.business_id?.toString()];
      ownerName = fallback || "Company Admin";
    }

    return ownerName;
  }

  static async _getOwnerNames(projects) {
    const db = getDB();
    const uniqueBusinessIds = [...new Set(projects.map(p => p.business_id?.toString()).filter(Boolean))];
    const businesses = await db.collection("user_businesses")
      .find({ _id: { $in: uniqueBusinessIds.map(id => new ObjectId(id)) } })
      .toArray();

    const businessesMap = {};
    businesses.forEach(b => businessesMap[b._id.toString()] = b);

    const bOwnerIds = [...new Set(businesses.map(b => b.user_id?.toString()).filter(Boolean))];
    const bOwners = await UserModel.getAll({ _id: { $in: bOwnerIds.map(id => new ObjectId(id)) } });
    const bOwnerNames = {};
    bOwners.forEach(u => {
      bOwnerNames[u._id.toString()] = u.name || (u.role_name === 'company_admin' ? "Company Admin" : "Business Owner");
    });

    const bizOwnerFallbackMap = {};
    businesses.forEach(b => {
      if (b.user_id) bizOwnerFallbackMap[b._id.toString()] = bOwnerNames[b.user_id.toString()];
    });

    const uniqueOwnerIds = [...new Set(projects.map(p => p.accountable_owner_id?.toString()).filter(Boolean))];
    const ownerUsersInfo = await UserModel.getAll({ _id: { $in: uniqueOwnerIds.map(id => new ObjectId(id)) } });
    const ownerNameMap = {};
    ownerUsersInfo.forEach(u => ownerNameMap[u._id.toString()] = u.name || (u.role_name === 'company_admin' ? "Company Admin" : "User"));

    return { ownerNameMap, bizOwnerFallbackMap, businessesMap };
  }

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
        launch_status,
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

      if (status) {
        if (status === "launched") {
          filter.launch_status = PROJECT_LAUNCH_STATUS.LAUNCHED;
        } else {
          filter.status = status;
        }
      }

      if (launch_status) filter.launch_status = launch_status;

      if (q) {
        filter.$or = [
          { project_name: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
        ];
      }

      const raw = await ProjectModel.findAll(filter);
      const total = await ProjectModel.count(filter);
      let projects = await ProjectModel.populateCreatedBy(raw);

      const projectIds = projects.map(p => p._id);

      const { ownerNameMap, bizOwnerFallbackMap, businessesMap } = await ProjectController._getOwnerNames(projects);


      const allLogs = await db.collection("decision_logs")
        .find({ project_id: { $in: projectIds } })
        .sort({ changed_at: -1 })
        .toArray();

      const logsByProject = {};
      allLogs.forEach(log => {
        const idStr = log.project_id.toString();
        if (!logsByProject[idStr]) logsByProject[idStr] = [];
        logsByProject[idStr].push(log);
      });


      projects = projects.map(project => {
        let cleanDesc = project.description || "";
        if (cleanDesc.startsWith("PMF Tactical Action:")) {
          cleanDesc = cleanDesc
            .replace(/^PMF Tactical Action: /, '')
            .split('\n')[0];
        }

        const ownerName = ProjectController._resolveOwner(project, ownerNameMap, bizOwnerFallbackMap);

        return {
          ...project,
          description: cleanDesc,
          accountable_owner: ownerName,
          allowed_collaborators: (project.allowed_collaborators || []).map(id => id.toString()),
          status: project.status, // Ensure status is returned
          decision_log: logsByProject[project._id.toString()] || (Array.isArray(project.decision_log) ? project.decision_log : []), // fallback to embedded if still there
          is_stale: isProjectStale(project.next_review_date),
        };
      });

      // Get status and access mode from the primary requested business context if applicable
      let businessStatus = null;
      let businessAccessMode = null;
      if (business_id && ObjectId.isValid(business_id) && businessesMap[business_id.toString()]) {
        const b = businessesMap[business_id.toString()];
        businessStatus = b.status;
        businessAccessMode = b.access_mode;
      }

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

          const roles = await db.collection("roles").find({}).toArray();
          const roleMap = {};
          roles.forEach(r => roleMap[r._id.toString()] = r.role_name);

          // Filter non-admins and non-viewers
          const nonAdminUsers = users.filter(u => {
            const roleName = roleMap[u.role_id?.toString()];
            return !ADMIN_ROLES.includes(roleName) && roleName !== 'viewer';
          });
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
        projects: projects.map(p => {
          const actualCadence = p.review_cadence || "";
          const nextReview = p.next_review_date || calculateNextReviewDate(p.last_reviewed || p.created_at, actualCadence);
          return {
            ...p,
            review_cadence: actualCadence,
            next_review_date: nextReview,
            is_stale: p.launch_status === 'launched' ? isProjectStale(nextReview) : false
          };
        }),
        business_status: businessStatus,
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
      
      const actualCadence = project.review_cadence || "";
      const nextReview = project.next_review_date || calculateNextReviewDate(project.last_reviewed || project.created_at, actualCadence);
      project.review_cadence = actualCadence;
      project.next_review_date = nextReview;
      project.is_stale = project.launch_status === 'launched' ? isProjectStale(nextReview) : false;

      const { ownerNameMap, bizOwnerFallbackMap } = await ProjectController._getOwnerNames([project]);
      project.accountable_owner = ProjectController._resolveOwner(project, ownerNameMap, bizOwnerFallbackMap);

      // Attach decision logs from the separate collection
      const DecisionLogModel = require("../models/decisionLogModel");
      project.decision_log = await DecisionLogModel.findByProjectId(id);

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
        explicitly_out_of_scope,
        accountable_owner_id
      } = req.body;

      // Required fields
      if (!business_id || !project_name) {
        return res.status(400).json({
          error: "business_id and project_name are required",
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



      // Permission
      const permissions = getProjectPermissions({
        projectStatus: PROJECT_STATES.DRAFT,
        isOwner,
        isCollaborator,
        isAdmin,
        userRole: req.user.role.role_name,
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
        accountable_owner: await (async () => {
          if (accountable_owner_id && ObjectId.isValid(accountable_owner_id)) {
            const ownerUser = await UserModel.findById(accountable_owner_id);
            if (ownerUser) return ownerUser.name || ownerUser.email;
          }
          return normalizeString(accountable_owner);
        })(),
        key_assumptions: Array.isArray(key_assumptions)
          ? key_assumptions.slice(0, 3).map(normalizeString)
          : [],
        success_criteria: normalizeString(success_criteria),
        kill_criteria: normalizeString(kill_criteria),
        review_cadence: normalizeString(review_cadence),
        accountable_owner_id: accountable_owner_id ? new ObjectId(accountable_owner_id) : null,
        status: status || PROJECT_STATES.DRAFT,
        launch_status: PROJECT_LAUNCH_STATUS.UNLAUNCHED,
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
        next_review_date: calculateNextReviewDate(last_reviewed || new Date(), review_cadence),
        created_at: new Date(),
        updated_at: new Date(),
      };

      const insertedId = await ProjectModel.create(data);

      // // Ensure the business owner is always a collaborator once projects exist
      // if (!isAdmin) {
      //   try {
      //     if (business.user_id) {
      //       const ownerIdStr = business.user_id.toString();
      //       const alreadyCollaborator = Array.isArray(business.collaborators)
      //         ? business.collaborators.some((id) => id.toString() === ownerIdStr)
      //         : false;

      //       if (!alreadyCollaborator) {
      //         await BusinessModel.addCollaborator(
      //           business._id.toString(),
      //           ownerIdStr
      //         );
      //       }
      //     }
      //   } catch (collabErr) {
      //     console.error("Failed to auto-assign owner as collaborator:", collabErr);
      //     // We do not throw here to avoid blocking project creation if this step fails
      //   }
      // }

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

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

      // Block ANY updates to terminal states
      if ((existing.status === PROJECT_STATES.COMPLETED || existing.status === PROJECT_STATES.SCALED) ||
        (existing.status === PROJECT_STATES.KILLED && !isAdmin)) {
        return res.status(403).json({
          error: `This project is in a terminal state (${existing.status}) and cannot be modified.`
        });
      }

      const tierName = await TierService.getUserTier(req.user._id);
      if (!await TierService.canCreateProject(tierName)) {
        return res.status(403).json({
          error: `Project editing is locked for ${tierName} plan. Upgrade to Advanced to execute your strategy.`
        });
      }

      if (existing.status === "launched") {
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

      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isAllowedCollaborator = Array.isArray(existing.allowed_collaborators) &&
        existing.allowed_collaborators.some(id => id.toString() === req.user._id.toString());

      const permissions = getProjectPermissions({
        projectStatus: existing.status,
        isOwner,
        isCollaborator,
        isAdmin,
        isAllowedCollaborator,
        userRole: req.user.role.role_name,
      });

      if (!permissions.canEdit) {
        return res.status(403).json({
          error: `You cannot edit this project in its current status. Special access from an admin may be required for launched projects.`,
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

      if (req.body.accountable_owner_id !== undefined) {
        const ownerId = req.body.accountable_owner_id;
        if (ownerId === "" || ownerId === null) {
          updateData.accountable_owner_id = null;
        } else if (ObjectId.isValid(ownerId)) {
          updateData.accountable_owner_id = new ObjectId(ownerId);
          // Sync name if possible
          const ownerUser = await UserModel.findById(ownerId);
          if (ownerUser) {
            updateData.accountable_owner = ownerUser.name || ownerUser.email;
          }
        }
      }

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

          // Validation for state transition
          const transition = validateStateTransition(existing.status, existing.launch_status, found, isAdmin);
          if (!transition.isValid) {
            return res.status(400).json({ error: transition.error });
          }

          if (found !== existing.status) {

            if (!req.body.justification || String(req.body.justification).trim() === "") {
              return res.status(400).json({
                error: "Justification is required when changing project status."
              });
            }

            const justification = String(req.body.justification).trim();

            // Allow alphabets + spaces + punctuation
            const validSentence = /^[A-Za-z\s.,'-]+$/;

            if (!validSentence.test(justification)) {
              return res.status(400).json({
                error: "Justification must contain only letters and valid sentence punctuation."
              });
            }

            const logEntry = {
              project_id: new ObjectId(id),
              from_status: existing.status,
              to_status: found,
              justification: justification,
              changed_by: new ObjectId(req.user._id),
              changed_at: new Date()
            };

            await DecisionLogModel.create(logEntry);
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

      if (req.body.last_reviewed !== undefined || req.body.review_cadence !== undefined) {
        const lr = req.body.last_reviewed !== undefined ? req.body.last_reviewed : existing.last_reviewed;
        const rc = req.body.review_cadence !== undefined ? req.body.review_cadence : existing.review_cadence;

        if (req.body.last_reviewed !== undefined) {
          updateData.last_reviewed = (req.body.last_reviewed === null || req.body.last_reviewed === "") ? null : new Date(req.body.last_reviewed);
        }

        updateData.next_review_date = calculateNextReviewDate(lr || new Date(), rc);
      }

      delete updateData._id;
      delete updateData.business_id;
      delete updateData.created_at;

      await ProjectModel.update(id, updateData);

      const updated = await ProjectModel.findById(id);
      const [project] = await ProjectModel.populateCreatedBy(updated);
      project.is_stale = project.launch_status === 'launched' ? isProjectStale(project.next_review_date) : false;

      res.json({
        message: "Project updated successfully",
        project,
      });
    } catch (err) {
      console.error("PROJECT UPDATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }

  static async launchProjects(req, res) {
    try {
      const { project_ids } = req.body;

      if (!Array.isArray(project_ids) || project_ids.length === 0) {
        return res.status(400).json({ error: "project_ids must be a non-empty array" });
      }

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      if (!isAdmin) {
        return res.status(403).json({ error: "Only admins can launch projects" });
      }

      // 1. Basic project check and get business_id
      const projectsToLaunch = [];
      let businessId = null;

      for (const id of project_ids) {
        if (!ObjectId.isValid(id)) continue;
        const project = await ProjectModel.findById(id);
        if (!project) continue;

        if (!project.review_cadence || project.review_cadence.trim() === "") {
          return res.status(400).json({ error: `Project '${project.project_name}' is missing a review cadence. Please set one before launching.` });
        }
        if (!businessId) businessId = project.business_id;
        projectsToLaunch.push(project);
      }

      if (projectsToLaunch.length === 0) {
        return res.status(404).json({ error: "No valid projects found to launch" });
      }

      // 2. Persist the selection: Mark selected as PENDING_LAUNCH, reset others (if not already LAUNCHED)
      await ProjectModel.collection().updateMany(
        {
          business_id: new ObjectId(businessId),
          launch_status: { $ne: PROJECT_LAUNCH_STATUS.LAUNCHED }
        },
        { $set: { launch_status: PROJECT_LAUNCH_STATUS.UNLAUNCHED, updated_at: new Date() } }
      );

      await ProjectModel.collection().updateMany(
        { _id: { $in: project_ids.map(id => new ObjectId(id)) } },
        { 
          $set: { 
            launch_status: PROJECT_LAUNCH_STATUS.PENDING_LAUNCH, 
            edit_unlocked: false,
            allowed_collaborators: [],
            updated_at: new Date() 
          } 
        }
      );

      // NEW: Unlock rankings to allow collaborators to provide input on the new selection
      await ProjectRankingModel.unlockRankingByBusiness(businessId);

      // 3. Admin Ranking Check: Admin must have ranked all selected projects
      const adminRankings = await ProjectRankingModel.collection().find({
        user_id: new ObjectId(req.user._id),
        project_id: { $in: project_ids.map(id => new ObjectId(id)) },
        rank: { $ne: null }
      }).toArray();

      if (adminRankings.length < project_ids.length) {
        const rankedIds = new Set(adminRankings.map(r => r.project_id.toString()));
        const unrankedProjectNames = projectsToLaunch
          .filter(p => !rankedIds.has(p._id.toString()))
          .map(p => p.project_name);

        const bulletedList = unrankedProjectNames.map(name => `• ${name}`).join("\n");
        return res.status(400).json({
          error: `Launch failed: Numerical ranks are mandatory for all projects moved to 'Launched'. The following projects are not ranked:\n${bulletedList}\n\nPlease assign ranks before launching.`
        });
      }

      // 4. Consensus check: All non-admin collaborators must have a rank for ALL launched/pending projects
      const business = await BusinessModel.findById(businessId);
      if (business) {
        const collaboratorIds = (business.collaborators || []).map(id => id.toString());
        const uniqueCollaboratorIds = [...new Set(collaboratorIds)];
        const db = getDB();

        const users = await db.collection("users").find({
          _id: { $in: uniqueCollaboratorIds.map(id => new ObjectId(id)) }
        }).toArray();

        const roles = await db.collection("roles").find({}).toArray();


        const roleMap = {};


        roles.forEach(r => roleMap[r._id.toString()] = r.role_name);



        const nonAdminUsers = users.filter(u => {


          const roleName = roleMap[u.role_id?.toString()];


          return !ADMIN_ROLES.includes(roleName) && roleName !== 'viewer';


        });

        // Find all projects that have AI ranks OR are being launched now
        const mandatoryProjects = await ProjectModel.collection().find({
          business_id: new ObjectId(businessId),
          $or: [
            { ai_rank: { $exists: true, $ne: null } },
            { _id: { $in: project_ids.map(id => new ObjectId(id)) } }
          ]
        }).toArray();

        const mandatoryProjectIds = mandatoryProjects.map(p => p._id);

        let consensusReached = true;
        const incompleteUsers = [];

        for (const user of nonAdminUsers) {
          const userRankings = await ProjectRankingModel.collection().find({
            business_id: new ObjectId(businessId),
            user_id: user._id,
            project_id: { $in: mandatoryProjectIds },
            rank: { $ne: null }
          }).toArray();

          if (userRankings.length < mandatoryProjectIds.length) {
            consensusReached = false;
            incompleteUsers.push(user.name || user.email);
          }
        }

        if (!consensusReached) {
          return res.status(403).json({
            error: "Waiting for all collaborators to save their rankings before launching.",
            incomplete_users: incompleteUsers
          });
        }
      }

      const results = [];
      for (const project of projectsToLaunch) {
        const id = project._id;

        // Check if project is killed
        if (project.status === PROJECT_STATES.KILLED) {
          results.push({ id, status: "failed", error: "Killed projects cannot be launched", is_ranked: false });
          continue;
        }

        // Check if project is already launched
        if (project.launch_status === PROJECT_LAUNCH_STATUS.LAUNCHED) {
          // If already launched, we only allow "re-launching" if the project is currently 
          // at-risk or paused, to move it back to active.
          const currentStatus = (project.status || "").toLowerCase().trim();
          const isAtRisk = currentStatus === "at risk" || currentStatus === "at_risk";
          const isPaused = currentStatus === "paused";

          if (!isAtRisk && !isPaused) {
            results.push({ id, status: "already_launched", is_ranked: true });
            continue;
          }
        }

        // Perform launch
        const now = new Date();
        const cadenceToUse = (project.review_cadence || "").trim();

        await ProjectModel.update(id, {
          status: PROJECT_STATES.ACTIVE,
          launch_status: PROJECT_LAUNCH_STATUS.LAUNCHED,
          review_cadence: cadenceToUse,
          last_reviewed: now,
          next_review_date: calculateNextReviewDate(now, cadenceToUse),
          updated_at: now
        });

        results.push({ id, status: "launched", is_ranked: true });
      }

      res.json({
        message: "Project launch check complete",
        results
      });
    } catch (err) {
      console.error("PROJECT LAUNCH ERR:", err);
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
        if (p.rank !== null && (typeof p.rank !== "number" || p.rank < 1)) {
          return res.status(400).json({ error: "Invalid rank value" });
        }
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) return res.status(404).json({ error: "Business not found" });

      const isAdmin = ["company_admin", "super_admin"].includes(req.user.role.role_name);

      // Enforce reranking access for collaborators during launched or reprioritizing states
      if (business.status === "launched" || business.status === "reprioritizing") {
        if (!isAdmin) {
          const allowed = await BusinessModel.getAllowedRankingCollaborators(business_id);
          const allowedIds = allowed.map(uid => uid.toString());

          if (!allowedIds.includes(user_id.toString())) {
            return res.status(403).json({
              error: `You are not allowed to rank projects for this business as it is in ${business.status} state. Admin permission required.`,
            });
          }
        }
      }

      const existingRankings = await ProjectRankingModel.collection()
        .find({
          user_id: new ObjectId(user_id),
          business_id: new ObjectId(business_id)
        })
        .toArray();

      const allBusinessProjects = await ProjectModel.collection().find({
        business_id: new ObjectId(business_id)
      }).toArray();

      const terminalStates = [PROJECT_STATES.KILLED, PROJECT_STATES.COMPLETED, PROJECT_STATES.SCALED];

      const excludedProjectIds = allBusinessProjects
        .filter(p => terminalStates.includes(p.status))
        .map(p => p._id.toString());

      const incomingRankMap = {};
      projects.forEach(p => {
        incomingRankMap[p.project_id.toString()] = p;
      });

      const finalProjectsToProcess = [...projects];
      const processedIds = new Set(projects.map(p => p.project_id.toString()));

      excludedProjectIds.forEach(exId => {
        if (!processedIds.has(exId)) {
          finalProjectsToProcess.push({
            project_id: exId,
            rank: null,
            rationals: ""
          });
        }
      });

      const projectStatusMap = {};
      allBusinessProjects.forEach(p => {
        projectStatusMap[p._id.toString()] = p.status;
      });

      const rankingDocs = finalProjectsToProcess
        .map(p => {
          const projIdStr = p.project_id;
          const projectStatus = projectStatusMap[projIdStr];

          const rank = terminalStates.includes(projectStatus) ? null : p.rank;

          return {
            user_id: new ObjectId(user_id),
            business_id: new ObjectId(business_id),
            project_id: new ObjectId(projIdStr),
            rank: rank,
            rationals: p.rationals || "",
            locked: true, // Saving is final, automatically lock
          };
        });

      await ProjectRankingModel.bulkUpsert(rankingDocs);

      // NEW: Grant rerank access to this collaborator for restricted states
      if (!isAdmin) {
        await BusinessModel.addAllowedRankingCollaborator(business_id, user_id);
      }

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

        const roles = await db.collection("roles").find({}).toArray();


        const roleMap = {};


        roles.forEach(r => roleMap[r._id.toString()] = r.role_name);



        const nonAdminUsers = users.filter(u => {


          const roleName = roleMap[u.role_id?.toString()];


          return !ADMIN_ROLES.includes(roleName) && roleName !== 'viewer';


        });

        // Mandatory projects are those with an AI rank
        const mandatoryProjects = await ProjectModel.collection().find({
          business_id: new ObjectId(business_id),
          ai_rank: { $exists: true, $ne: null }
        }).toArray();
        const mandatoryProjectIds = mandatoryProjects.map(p => p._id);
        const mandatoryProjectIdStrs = mandatoryProjectIds.map(id => id.toString());

        const lockedUsers = [];

        for (const user of nonAdminUsers) {
          const userRankings = await ProjectRankingModel.collection().find({
            business_id: new ObjectId(business_id),
            user_id: user._id,
            project_id: { $in: mandatoryProjectIds },
            rank: { $ne: null }
          }).toArray();

          // A user is considered "done" if they have ranked all projects with AI ranks
          if (mandatoryProjectIds.length > 0 && userRankings.length >= mandatoryProjectIds.length) {
            lockedUsers.push({
              user_id: user._id,
              name: user.name,
              email: user.email,
            });
          }
        }

        ranking_lock_summary = {
          total_users: nonAdminUsers.length,
          locked_users_count: lockedUsers.length,
          locked_users: lockedUsers,
          mandatory_project_ids: mandatoryProjectIdStrs
        };
      }

      const allProjects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id),
      });

      const rankingMap = {};
      rankings.forEach(r => {
        rankingMap[r.project_id.toString()] = r;
      });

      const ordered = allProjects.map(project => {
        const ranking = rankingMap[project._id.toString()];
        return {
          ranking: ranking || { rank: null, rationals: "", locked: false },
          project
        };
      });

      // Sort: ranked first by rank (ascending), then unranked by creation date
      ordered.sort((a, b) => {
        const rankA = a.ranking.rank === null ? Infinity : a.ranking.rank;
        const rankB = b.ranking.rank === null ? Infinity : b.ranking.rank;

        if (rankA !== rankB) {
          return rankA - rankB;
        }

        return new Date(a.project.created_at) - new Date(b.project.created_at);
      });

      const { ownerNameMap, bizOwnerFallbackMap } = await ProjectController._getOwnerNames(allProjects);

      const populatedProjects = await ProjectModel.populateCreatedBy(allProjects);

      const responseProjects = ordered.map(({ ranking, project: rawProject }) => {
        const project = populatedProjects.find(p => p._id.toString() === rawProject._id.toString()) || rawProject;
        const actualCadence = project.review_cadence || "";
        const nextReview = project.next_review_date || calculateNextReviewDate(project.last_reviewed || project.created_at, actualCadence);
        return {
          ...project,
          review_cadence: actualCadence,
          project_id: project._id,
          project_name: project.project_name,
          accountable_owner: ProjectController._resolveOwner(project, ownerNameMap, bizOwnerFallbackMap),
          rank: ranking.rank,
          rationals: ranking.rationals || "",
          locked: ranking.locked || false,
          ai_rank: project.ai_rank || null,
          ai_rank_score: project.ai_rank_score || null,
          next_review_date: nextReview,
          is_stale: project.launch_status === 'launched' ? isProjectStale(nextReview) : false,
        };
      });

      res.json({
        user_id,
        business_id,
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

      const { ownerNameMap, bizOwnerFallbackMap } = await ProjectController._getOwnerNames(projects);

      const populatedProjects = await ProjectModel.populateCreatedBy(projects);

      const rankMap = {};
      rankings.forEach(r => {
        rankMap[r.project_id.toString()] = r.rank;
      });

      const ranked = [];
      const unranked = [];

      populatedProjects.forEach(p => {
        const actualCadence = p.review_cadence || "";
        const nextReview = p.next_review_date || calculateNextReviewDate(p.last_reviewed || p.created_at, actualCadence);
        const rank = rankMap[p._id.toString()] ?? null;
        const item = {
          ...p,
          review_cadence: actualCadence,
          admin_user_id: admin_user_id,
          business_id,
          project_id: p._id,
          accountable_owner: ProjectController._resolveOwner(p, ownerNameMap, bizOwnerFallbackMap),
          rank,
          created_at: p.created_at,
          next_review_date: nextReview,
          is_stale: p.launch_status === 'launched' ? isProjectStale(nextReview) : false,
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

      if (found.status === PROJECT_STATES.KILLED || found.status === PROJECT_STATES.COMPLETED || found.status === PROJECT_STATES.SCALED) {
        return res.status(403).json({
          error: `Project is already in a terminal state (${found.status})`
        });
      }

      await ProjectModel.update(id, {
        status: PROJECT_STATES.KILLED,
        updated_at: new Date()
      });

      res.json({
        message: "Project killed successfully and rankings cleared",
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

      const VALID_STATUS = Object.values(PROJECT_STATES);
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

      // Lifecycle transition validation
      const validation = validateStateTransition(project.status, project.launch_status, status);
      if (!validation.isValid) {
        return res.status(400).json({ error: validation.error });
      }

      const updateUpdate = { status, updated_at: new Date() };

      await ProjectModel.collection().updateOne(
        { _id: new ObjectId(id) },
        { $set: updateUpdate }
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
        // Unlock the project for editing
        await ProjectModel.update(project_id, { edit_unlocked: true });

        return res.json({
          scope: "project",
          message: "Project edit access has been granted",
          project_id,
          current_status: project.status,
        });
      }

      if (scope === "reRanking") {
        await ProjectRankingModel.unlockRankingByBusiness(business_id);

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
        has_rerank_access: hasRerankAccess,
        has_project_edit_access: hasProjectEditAccess,
      };
      res.json(response);
    } catch (err) {
      console.error("CHECK ACCESS ERR:", err);
      res.status(500).json({ error: "Server error", details: err.message });
    }
  }

  static async checkAllAccess(req, res) {
    try {
      const { business_id } = req.query;
      const user_id = req.user._id;

      if (!ObjectId.isValid(business_id)) {
        return res.status(400).json({ error: "Invalid business_id" });
      }

      const business = await BusinessModel.findById(business_id);
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }

      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

      // Check rerank access
      let hasRerankAccess = false;
      try {
        const businessStatus = business.status || "draft";
        const isRestrictedRankingState = businessStatus === "launched" || businessStatus === "reprioritizing" || businessStatus === "prioritized";

        const allowedRankingCollabs = await BusinessModel.getAllowedRankingCollaborators(business_id);
        const isAllowedToRank = allowedRankingCollabs.some(id => id.toString() === user_id.toString());

        if (isAdmin) {
          hasRerankAccess = true;
        } else {
          // Check if the user has already locked their rankings for this business
          const rankings = await ProjectRankingModel.findByUserAndBusiness(user_id, business_id);
          const hasLockedRanking = rankings.some(r => r.locked === true);

          if (isRestrictedRankingState) {
            hasRerankAccess = isAllowedToRank && !hasLockedRanking;
          } else {
            hasRerankAccess = !hasLockedRanking;
          }
        }
      } catch (err) {
        console.error("Error checking rerank access:", err);
        hasRerankAccess = isAdmin;
      }

      // Check edit access for all projects in this business
      const projects = await ProjectModel.findAll({ business_id: new ObjectId(business_id) });
      const projectsEditAccess = {};
      const userRole = req.user.role.role_name;

      projects.forEach(project => {
        if (isAdmin) {
          projectsEditAccess[project._id.toString()] = true;
          return;
        }

        // Viewer NEVER has edit access
        if (userRole === "viewer") {
          projectsEditAccess[project._id.toString()] = false;
          return;
        }

        const isLaunchedOrPending = (project.launch_status || "").toLowerCase() === "launched" || (project.launch_status || "").toLowerCase() === "pending_launch";

        const isInAllowedCollabs = Array.isArray(project.allowed_collaborators) &&
          project.allowed_collaborators.some(id => id.toString() === user_id.toString());

        if (isLaunchedOrPending) {
          // For launched or pending launch projects, only those with special access can edit
          projectsEditAccess[project._id.toString()] = isInAllowedCollabs;
        } else {
          // For unlaunched/draft projects, any collaborator/user can edit
          projectsEditAccess[project._id.toString()] = true;
        }
      });

      res.json({
        business_id,
        has_rerank_access: hasRerankAccess,
        projects_edit_access: projectsEditAccess,
      });
    } catch (err) {
      console.error("CHECK ALL ACCESS ERR:", err);
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
          const currentCols = Array.isArray(project.allowed_collaborators) ? project.allowed_collaborators : [];
          const filteredCollaborators = currentCols.filter(
            id => id.toString() !== user_id.toString()
          );

          return ProjectModel.update(project._id.toString(), {
            allowed_collaborators: filteredCollaborators,
            updated_at: new Date()
          });
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

      // Verify admin access (redundant if using requireAdmin middleware but good for safety)
      if (!req.user || !req.user.role || !ADMIN_ROLES.includes(req.user.role.role_name)) {
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

      // NEW: Unlock rankings when AI rankings are saved (kickstart)
      await ProjectRankingModel.unlockRankingByBusiness(business_id);

      // NEW: Automatically move business to prioritizing phase during kickstart
      await BusinessModel.collection().updateOne(
        { _id: new ObjectId(business_id) },
        { $set: { status: "prioritizing", updated_at: new Date() } }
      );

      // Kickstart: set non-launched projects to Draft and assumptions to "testing"
      // Projects that are already launched (active) or in terminal states (killed/completed) must NOT be reset to draft
      await ProjectModel.collection().updateMany(
        {
          business_id: new ObjectId(business_id),
          launch_status: { $ne: PROJECT_LAUNCH_STATUS.LAUNCHED },
          status: { $nin: [PROJECT_STATES.KILLED, PROJECT_STATES.COMPLETED] }
        },
        {
          $set: {
            status: PROJECT_STATES.DRAFT,
            learning_state: "testing",
            updated_at: new Date()
          }
        }
      );

      // Bulk update AI ranks on projects 
      // FIRST: Reset all existing AI ranks for this business to ensure exclusivity
      await ProjectModel.collection().updateMany(
        { business_id: new ObjectId(business_id) },
        {
          $set: {
            ai_rank: null,
            ai_rank_score: null,
            ai_rank_factors: {},
            updated_at: new Date()
          }
        }
      );

      // SECOND: Apply the new rankings
      // We should avoid applying AI ranks to projects that are KILLED or COMPLETED
      const projectIds_AI = ai_rankings.map(r => new ObjectId(r.project_id));
      const projectsData_AI = await ProjectModel.collection().find({
        _id: { $in: projectIds_AI }
      }, { projection: { status: 1 } }).toArray();

      const projectStatusMap_AI = {};
      projectsData_AI.forEach(p => projectStatusMap_AI[p._id.toString()] = p.status);

      const filteredAIRankings = ai_rankings.filter(r => {
        const s = projectStatusMap_AI[r.project_id.toString()];
        return s !== PROJECT_STATES.KILLED && s !== PROJECT_STATES.COMPLETED;
      });

      const bulkResult = await ProjectModel.bulkUpdateAIRanks(filteredAIRankings);

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

      // Get all projects with AI rankings OR projects targeted for launch
      const projects = await ProjectModel.findAll({
        business_id: new ObjectId(business_id),
        $or: [
          { ai_rank: { $exists: true, $ne: null } },
          { launch_status: { $in: [PROJECT_LAUNCH_STATUS.LAUNCHED, PROJECT_LAUNCH_STATUS.PENDING_LAUNCH] } }
        ]
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

      const roles = await db.collection("roles").find({}).toArray();
      const roleMap = {};
      roles.forEach(r => roleMap[r._id.toString()] = r.role_name);

      const nonAdminUserIds = users
        .filter(u => {
          const roleName = roleMap[u.role_id?.toString()];
          return !ADMIN_ROLES.includes(roleName) && roleName !== 'viewer';
        })
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

      const roles = await db.collection("roles").find({}).toArray();


      const roleMap = {};


      roles.forEach(r => roleMap[r._id.toString()] = r.role_name);



      const nonAdminUsers = users.filter(u => {


        const roleName = roleMap[u.role_id?.toString()];


        return !ADMIN_ROLES.includes(roleName) && roleName !== 'viewer';


      });
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

  static async getDecisionLogs(req, res) {
    try {
      const { projectId } = req.params;
      console.log(`[ProjectController] Fetching decision logs for project: ${projectId}`);

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const logs = await DecisionLogModel.findByProjectId(projectId);

      res.json({
        message: "Decision logs fetched successfully",
        logs
      });

    } catch (err) {
      console.error("GET DECISION LOGS ERROR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }



  static async adhocUpdate(req, res) {
    try {
      const { id } = req.params;
      const { status, learning_state, justification } = req.body;

      if (!justification) {
        return res.status(400).json({ error: "Justification is mandatory for ad-hoc updates" });
      }

      const existing = await ProjectModel.findById(id);
      if (!existing) return res.status(404).json({ error: "Project not found" });

      // Permission check
      const business = await BusinessModel.findById(existing.business_id);
      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(c => c.toString() === req.user._id.toString());

      const isOwnerAccountable = existing.accountable_owner_id && existing.accountable_owner_id.toString() === req.user._id.toString();

      if (!isAdmin && !isOwnerAccountable && !permissions.canEdit) {
        return res.status(403).json({ error: "You do not have permission to update this project. Only admins or the accountable owner can perform updates." });
      }

      const updateData = {
        updated_at: new Date()
      };

      if (status) updateData.status = status;
      if (learning_state) updateData.learning_state = learning_state;

      await ProjectModel.update(id, updateData);

      const updated = await ProjectModel.findById(id);
      const [project] = await ProjectModel.populateCreatedBy(updated);
      project.is_stale = project.launch_status === 'launched' ? isProjectStale(project.next_review_date) : false;

      // Log the decision
      const db = getDB();
      await db.collection("audit_trail").insertOne({
        user_id: new ObjectId(req.user._id),
        event_type: "project_decision_log",
        event_data: {
          project_id: new ObjectId(id),
          business_id: existing.business_id,
          action: "adhoc_update",
          justification,
          old_state: { status: existing.status, learning_state: existing.learning_state },
          new_state: { status: status || existing.status, learning_state: learning_state || existing.learning_state }
        },
        timestamp: new Date()
      });

      await DecisionLogModel.create({
        project_id: new ObjectId(id),
        changed_at: new Date(),
        from_status: existing.status || "Draft",
        to_status: status || existing.status || "Draft",
        justification,
        user_id: new ObjectId(req.user._id)
      });

      res.json({ message: "Ad-hoc update processed", project });
    } catch (err) {
      console.error("ADHOC UPDATE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
  static async performReview(req, res) {
    try {
      const { id } = req.params;
      const { status, learning_state, justification, no_changes } = req.body;

      if (!justification) {
        return res.status(400).json({ error: "Justification is mandatory for reviews" });
      }

      const existing = await ProjectModel.findById(id);
      if (!existing) return res.status(404).json({ error: "Project not found" });

      // Permission check
      const business = await BusinessModel.findById(existing.business_id);
      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);
      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(c => c.toString() === req.user._id.toString());

      const isOwnerAccountable = existing.accountable_owner_id && existing.accountable_owner_id.toString() === req.user._id.toString();

      if (!isAdmin && !isOwnerAccountable && !permissions.canEdit) {
        return res.status(403).json({ error: "You do not have permission to review this project. Only admins or the accountable owner can perform reviews." });
      }

      const now = new Date();
      const actualCadence = existing.review_cadence || "Monthly";
      const updateData = {
        last_reviewed: now,
        updated_at: now,
        review_cadence: actualCadence,
        next_review_date: calculateNextReviewDate(now, actualCadence)
      };

      if (!no_changes) {
        if (status) updateData.status = status;
        if (learning_state) updateData.learning_state = learning_state;
      }

      await ProjectModel.update(id, updateData);

      const updated = await ProjectModel.findById(id);
      const [project] = await ProjectModel.populateCreatedBy(updated);
      project.is_stale = project.launch_status === 'launched' ? isProjectStale(project.next_review_date) : false;

      // Log the decision
      const db = getDB();
      await db.collection("audit_trail").insertOne({
        user_id: new ObjectId(req.user._id),
        event_type: "project_decision_log",
        event_data: {
          project_id: new ObjectId(id),
          business_id: existing.business_id,
          action: no_changes ? "no_change_review" : "cadence_review",
          justification,
          old_state: { status: existing.status, learning_state: existing.learning_state },
          new_state: {
            status: no_changes ? existing.status : (status || existing.status),
            learning_state: no_changes ? existing.learning_state : (learning_state || existing.learning_state)
          }
        },
        timestamp: new Date()
      });

      await DecisionLogModel.create({
        project_id: new ObjectId(id),
        changed_at: new Date(),
        from_status: existing.status || "Draft",
        to_status: no_changes ? (existing.status || "Draft") : (status || existing.status || "Draft"),
        from_learning_state: existing.learning_state || "Testing",
        to_learning_state: no_changes ? (existing.learning_state || "Testing") : (learning_state || existing.learning_state || "Testing"),
        justification: `[Cadence Review] ${justification}`,
        user_id: new ObjectId(req.user._id)
      });

      res.json({ message: "Review processed", project });
    } catch (err) {
      console.error("PERFORM REVIEW ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}

module.exports = ProjectController;

