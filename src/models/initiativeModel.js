const { ObjectId } = require("mongodb");
const { getDB } = require("../config/database");

class InitiativeModel {
  static collection() {
    return getDB().collection("initiative");
  }

  static async findAll(filter = {}) {
    const coll = this.collection();
    return await coll.find(filter).sort({ created_at: -1 }).toArray();
  }

  static async findById(id) {
    const coll = this.collection();
    return await coll.findOne({ _id: new ObjectId(id) });
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
    const coll = this.collection();
    return await coll.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updated_at: new Date() } }
    );
  }

  static async delete(id) {
    const coll = this.collection();
    return await coll.deleteOne({ _id: new ObjectId(id) });
  }

  static async count(filter = {}) {
    const coll = this.collection();
    return await coll.countDocuments(filter);
  }
}

module.exports = InitiativeModel;
