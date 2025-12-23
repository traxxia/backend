const { ObjectId } = require("mongodb");
const ProjectFieldLockModel = require("../models/projectFieldLockModel");

const LOCK_DURATION_MS = 5 * 60 * 1000;

class ProjectFieldLockController {
  // Acquire / Refresh a field lock
  static async lock(req, res) {
    try {
      const { project_id } = req.params;
      const { field_name } = req.body;

      if (!field_name) {
        return res.status(400).json({ error: "field_name is required" });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + LOCK_DURATION_MS);

      const existingLock = await ProjectFieldLockModel.findActiveLock(
        project_id,
        field_name
      );

      if (
        existingLock &&
        existingLock.locked_by.toString() !== req.user._id.toString()
      ) {
        return res.status(409).json({
          error: "Field is currently being edited",
          locked_by: existingLock.locked_by_name,
          field_name,
        });
      }

      await ProjectFieldLockModel.refreshAllLocks(
        project_id,
        req.user._id,
        expiresAt
      );

      await ProjectFieldLockModel.lockField({
        business_id: new ObjectId(req.user.business_id),
        project_id: new ObjectId(project_id),
        field_name,
        locked_by: new ObjectId(req.user._id),
        locked_by_name: req.user.name || req.user.email,
        locked_at: now,
        last_activity_at: now,
        expires_at: expiresAt,
        status: "active",
      });

      res.json({ message: "Field locked", field_name });
    } catch (err) {
      console.error("LOCK FIELD ERROR:", err);
      res.status(500).json({ error: "Failed to lock field" });
    }
  }

  // Heartbeat – refresh ALL locks
  static async heartbeat(req, res) {
    try {
      const { project_id } = req.params;

      const expiresAt = new Date(Date.now() + LOCK_DURATION_MS);

      await ProjectFieldLockModel.refreshAllLocks(
        project_id,
        req.user._id,
        expiresAt
      );

      res.json({ message: "Lock heartbeat refreshed" });
    } catch (err) {
      console.error("HEARTBEAT ERROR:", err);
      res.status(500).json({ error: "Failed to refresh lock" });
    }
  }

  // Unlock on save / cancel
  static async unlock(req, res) {
    try {
      const { project_id } = req.params;
      const { fields = [] } = req.body;

      await ProjectFieldLockModel.unlockFields(
        project_id,
        req.user._id,
        fields
      );

      res.json({ message: "Fields unlocked" });
    } catch (err) {
      console.error("UNLOCK ERROR:", err);
      res.status(500).json({ error: "Failed to unlock fields" });
    }
  }

  // View current locks
  static async getLocks(req, res) {
    try {
      const { project_id } = req.params;

      const locks = await ProjectFieldLockModel.getLocksByProject(project_id);

      res.json({ locks });
    } catch (err) {
      console.error("GET LOCKS ERROR:", err);
      res.status(500).json({ error: "Failed to fetch locks" });
    }
  }
}

module.exports = ProjectFieldLockController;
