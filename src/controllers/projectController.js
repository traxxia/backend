const { ObjectId } = require("mongodb");
const ProjectModel = require("../models/projectModel");
const BusinessModel = require("../models/businessModel");
const ProjectRankingModel = require("../models/projectRankingModel");
const { getDB } = require("../config/database");

const VALID_STATUS = ["draft", "prioritizing", "prioritized", "launched"];
const ADMIN_ROLES = ["company_admin", "super_admin"];
const PROJECT_TYPES = ["immediate_action", "short_term_initiative", "long_term_shift"];

// Permission matrix for ALL project actions
function getProjectPermissions({
  businessStatus,
  isOwner,
  isCollaborator,
  isAdmin,
}) {
  switch (businessStatus) {
    case "draft":
      return {
        canCreate: isAdmin || isCollaborator,
        canEdit: isAdmin || isCollaborator,
      };
    case "prioritizing":
      return {
        canCreate: false,
        canEdit: isAdmin || isCollaborator,
      };

    case "prioritized":
      return {
        canCreate: false,
        canEdit: isAdmin || isCollaborator,
      };

    // fully locked
    case "launched":
      return {
        canCreate: false,
        canEdit: false,
      };

    default:
      return { canCreate: false, canEdit: false };
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
      const projects = await ProjectModel.populateCreatedBy(raw);


      let ranking_lock_summary = { locked_users_count: 0, total_users: 0 };

      if (business_id && ObjectId.isValid(business_id)) {
        const business = await BusinessModel.findById(business_id);
        if (business) {
          // Owner + collaborators
          const collaboratorIds = [
            business.user_id?.toString(),
            ...(business.collaborators || []).map(id => id.toString())
          ];

          const uniqueCollaboratorIds = [...new Set(collaboratorIds)];

          const users = await db.collection("users").find({
            _id: { $in: uniqueCollaboratorIds.map(id => new ObjectId(id)) }
          }).toArray();

          // Filter non-admins
          const nonAdminUserIds = users
            .filter(u => !ADMIN_ROLES.includes(u.role_name))
            .map(u => u._id.toString());

          // Locked counts for non-admins only
          const lockedUserIds = await ProjectRankingModel.collection().distinct("user_id", {
            business_id: new ObjectId(business_id),
            locked: true,
            user_id: { $in: nonAdminUserIds.map(id => new ObjectId(id)) }
          });

          ranking_lock_summary = {
            total_users: nonAdminUserIds.length,
            locked_users_count: lockedUserIds.length
          };
        }
      }

      res.json({ total, count: projects.length, projects, ranking_lock_summary, });
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

      } = req.body;

      // Required fields
      if (!business_id || !project_name) {
        return res.status(400).json({
          error: "business_id and project_name required",
        });
      }

      // Check business
      const business = await BusinessModel.findById(business_id);
      if (!business)
        return res.status(404).json({ error: "Business not found" });


      // User-collaborator
      if (ADMIN_ROLES.includes(req.user.role.role_name) && business.user_id) {
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
      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

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

      if (!project_type || !PROJECT_TYPES.includes(project_type)) {
        return res.status(400).json({
          error: "Invalid values",
        });
      }


      // Normalize fields for MongoDB validation
      const data = {
        business_id: new ObjectId(business_id),
        user_id: new ObjectId(req.user._id),
        project_name: project_name.trim(),
        project_type,
        description: normalizeString(description),
        why_this_matters: normalizeString(why_this_matters),
        impact: normalizeString(impact),
        effort: normalizeString(effort),
        risk: normalizeString(risk),
        strategic_theme: normalizeString(strategic_theme),
        dependencies: normalizeString(dependencies),
        high_level_requirements: normalizeString(high_level_requirements),
        scope_definition: normalizeString(scope_definition),
        expected_outcome: normalizeString(expected_outcome),
        success_metrics: normalizeString(success_metrics),
        estimated_timeline: normalizeString(estimated_timeline),
        budget_estimate:
          budget_estimate === "" ||
            budget_estimate === null ||
            budget_estimate === undefined
            ? ""
            : String(Number(budget_estimate)),
        status: "draft",
        created_at: new Date(),
        updated_at: new Date(),
      };

      const insertedId = await ProjectModel.create(data);

      // Ensure the business owner is always a collaborator once projects exist
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

      if (existing.status === "launched") {
        return res.status(403).json({
          error:
            "This project has been launched and cannot be updated anymore.",
        });
      }

      if (req.body.status === "launched") {
        if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
          return res.status(403).json({
            error: "Only company_admin or super_admin can launch projects",
          });
        }
      }

      // Check access
      const business = await BusinessModel.findById(existing.business_id);
      if (!business)
        return res.status(404).json({ error: "Parent business not found" });

      const isOwner = business.user_id.toString() === req.user._id.toString();
      const isCollaborator = business.collaborators?.some(
        (id) => id.toString() === req.user._id.toString()
      );
      const isAdmin = ADMIN_ROLES.includes(req.user.role.role_name);

      const permissions = getProjectPermissions({
        businessStatus: business.status,
        isOwner,
        isCollaborator,
        isAdmin,
      });

      if (!permissions.canEdit) {
        return res.status(403).json({
          error: `You cannot edit projects when business is in '${business.status}' state`,
        });
      }

      if (req.body.status && !VALID_STATUS.includes(req.body.status)) {
        return res.status(400).json({ error: "Invalid status value" });
      }

      // === FIXED: Normalize fields safely for strict string-only schema ===
      const updateData = {
        updated_at: new Date(),
      };

      // Only include fields if they are provided and valid
      if (req.body.description !== undefined)
        updateData.description = normalizeString(req.body.description);

      if (req.body.why_this_matters !== undefined)
        updateData.why_this_matters = normalizeString(
          req.body.why_this_matters
        );

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

      if (req.body.high_level_requirements !== undefined)
        updateData.high_level_requirements = normalizeString(
          req.body.high_level_requirements
        );

      if (req.body.scope_definition !== undefined)
        updateData.scope_definition = normalizeString(
          req.body.scope_definition
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
          updateData.budget_estimate = ""; // empty string is acceptable as "no budget set"
        } else {
          const num = Number(budget);
          updateData.budget_estimate = isNaN(num) ? "" : String(num);
        }
      }

      if (req.body.status) {
        updateData.status = req.body.status;
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

      // Check Business
      const business = await BusinessModel.findById(business_id);
      if (!business) return res.status(404).json({ error: "Business not found" });




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

      // get users and locking summary
      const business = await BusinessModel.findById(business_id);

      let ranking_lock_summary = {
        locked_users_count: 0,
        total_users: 0,
      };

      if (business) {

        // Get all collaborators for the business (exclude admins)
        const businessDoc = await BusinessModel.findById(business_id);
        const collaboratorIds = [
          businessDoc.user_id?.toString(), // owner
          ...(businessDoc.collaborators || []).map(id => id.toString())
        ];

        // Remove duplicates
        const uniqueCollaboratorIds = [...new Set(collaboratorIds)];

        // Fetch their roles
        const db = getDB();

        const users = await db.collection("users").find({
          _id: { $in: uniqueCollaboratorIds.map(id => new ObjectId(id)) }
        }).toArray();

        // Filter out admins
        const nonAdminUserIds = users
          .filter(u => !ADMIN_ROLES.includes(u.role_name))
          .map(u => u._id.toString());

        // Count locked users
        const lockedUserIds = await ProjectRankingModel.collection()
          .distinct("user_id", {
            business_id: new ObjectId(business_id),
            locked: true,
            user_id: { $in: nonAdminUserIds.map(id => new ObjectId(id)) }
          });

        ranking_lock_summary = {
          total_users: nonAdminUserIds.length,
          locked_users_count: lockedUserIds.length,
        };

      }
      if (rankings.length === 0) {
        return res.json({
          user_id,
          business_id,
          projects: [],
        });
      }

      // Fetch project
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
        locked: ranking.locked || false,
      }));

      res.json({
        user_id,
        business_id,
        projects: responseProjects,
        ranking_lock_summary
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

      // Lock the rank
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

      if (!ADMIN_ROLES.includes(req.user.role.role_name)) {
        return res.status(403).json({
          error: "Admin access required to delete project",
        });
      }

      await ProjectModel.delete(id);

      res.json({
        message: "Project deleted successfully",
        deleted: { id, project_name: found.project_name },
      });
    } catch (err) {
      console.error("PROJECT DELETE ERR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
}



module.exports = ProjectController;
