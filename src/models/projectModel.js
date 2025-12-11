const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");
const UserModel = require("./userModel");

class ProjectModel {
  static collection() {
    return getDB().collection("projects");
  }

  static async findAll(filter = {}) {
    return await this.collection()
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();
  }

  static async findById(id) {
    return await this.collection().findOne({ _id: new ObjectId(id) });
  }

  static async create(data) {
    const coll = this.collection();
    const now = new Date();
    const result = await coll.insertOne({
      ...data,
      created_at: now,
      updated_at: now,
    });
    return result.insertedId;
  }

  static async update(id, updateData) {
    return await this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updated_at: new Date() } }
    );
  }

  static async delete(id) {
    return await this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  static async count(filter = {}) {
    return await this.collection().countDocuments(filter);
  }

  // populate created_by field
  static async populateCreatedBy(projects) {
    if (!Array.isArray(projects)) projects = [projects];
    if (projects.length === 0) return projects;

    const userIds = [
      ...new Set(projects.map((p) => p.user_id).filter(Boolean)),
    ];
    if (userIds.length === 0) return projects;

    const users = await Promise.all(
      userIds.map((id) => UserModel.findById(id))
    );

    const userMap = {};
    users.forEach((user) => {
      if (user) {
        const name = user.name?.trim() || user.email || "Unknown User";
        userMap[user._id.toString()] = name;
      }
    });

    return projects.map((project) => ({
      ...project,
      created_by: userMap[project.user_id?.toString()] || "Unknown User",
    }));
  }
}

module.exports = ProjectModel;
