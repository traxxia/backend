const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

const COLLECTION = "projects_fields_locked";

class ProjectFieldLockModel {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  static async findActiveLock(projectId, fieldName) {
    return this.collection().findOne({
      project_id: new ObjectId(projectId),
      field_name: fieldName,
      expires_at: { $gt: new Date() },
    });
  }

  static async lockField(data) {
    return this.collection().updateOne(
      {
        project_id: data.project_id,
        field_name: data.field_name,
      },
      {
        $set: data,
      },
      { upsert: true }
    );
  }

  static async refreshAllLocks(projectId, userId, expiresAt) {
    return this.collection().updateMany(
      {
        project_id: new ObjectId(projectId),
        locked_by: new ObjectId(userId),
        expires_at: { $gt: new Date() },
      },
      {
        $set: {
          last_activity_at: new Date(),
          expires_at: expiresAt,
        },
      }
    );
  }

  static async unlockFields(projectId, userId, fields = []) {
    const filter = {
      project_id: new ObjectId(projectId),
      locked_by: new ObjectId(userId),
    };

    if (fields.length) {
      filter.field_name = { $in: fields };
    }

    return this.collection().deleteMany(filter);
  }

  static async getLocksByProject(projectId) {
    return this.collection()
      .find({
        project_id: new ObjectId(projectId),
        expires_at: { $gt: new Date() },
      })
      .toArray();
  }
}

module.exports = ProjectFieldLockModel;
