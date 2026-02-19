const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');

class AiHistoryModel {
    static collection() {
        return getDB().collection('ai_chat_history');
    }

    static async create(chatData) {
        const coll = this.collection();
        const doc = {
            user_id: new ObjectId(chatData.user_id),
            role: chatData.role,
            text: chatData.text,
            created_at: new Date(),
            updated_at: new Date()
        };

        // project_id is optional — if provided, scope to project
        if (chatData.project_id) {
            doc.project_id = new ObjectId(chatData.project_id);
        }

        const result = await coll.insertOne(doc);
        return result.insertedId;
    }

    /**
     * Fetch history scoped to a specific user.
     * If projectId is provided, also filter by project.
     * If projectId is null/undefined, return all messages for the user (no project scope).
     */
    static async findByUser(userId, projectId) {
        const coll = this.collection();
        const query = { user_id: new ObjectId(userId) };

        if (projectId === 'all') {
            // Return all messages for the user, regardless of project_id
        } else if (projectId) {
            query.project_id = new ObjectId(projectId);
        } else {
            // Only return messages that have NO project_id (global chat)
            query.project_id = { $exists: false };
        }

        return await coll
            .find(query)
            .sort({ created_at: 1 })
            .toArray();
    }

    static async deleteByProjectId(projectId) {
        const coll = this.collection();
        return await coll.deleteMany({ project_id: new ObjectId(projectId) });
    }
}

module.exports = AiHistoryModel;
