const { ObjectId } = require('mongodb');
const AiHistoryModel = require('../models/aiHistoryModel');
const ProjectModel = require('../models/projectModel');
const BusinessModel = require('../models/businessModel');

class AiHistoryController {

    /**
     * Helper: Validate project access.
     * Admins are NOT allowed to access chat history — only the message owner can.
     */
    static async validateProjectAccess(projectId, currentUser) {
        const project = await ProjectModel.findById(projectId);
        if (!project) return { error: 'Project not found' };

        const business = await BusinessModel.findById(project.business_id);
        if (!business) return { error: 'Business associated with project not found' };

        const isOwner = business.user_id.toString() === currentUser._id.toString();
        const isCollaborator = (business.collaborators || []).some(
            (id) => id.toString() === currentUser._id.toString()
        );

        // Admins are explicitly blocked from accessing chat history
        // Chat history is strictly personal — only the user who created it can see it
        if (!isOwner && !isCollaborator) {
            return { error: 'Not allowed to access history for this project' };
        }

        return { project, business };
    }

    /**
     * Store a chat message.
     * project_id is optional — if not provided, message is stored as global (user-scoped only).
     */
    static async storeChat(req, res) {
        try {
            const { project_id, role, text } = req.body;
            const userId = req.user._id;

            if (!role || !text) {
                return res.status(400).json({ error: 'role and text are required' });
            }

            // If project_id is provided, validate access to that project
            if (project_id) {
                const access = await AiHistoryController.validateProjectAccess(project_id, req.user);
                if (access.error) return res.status(403).json({ error: access.error });
            }

            const chatEntry = {
                user_id: userId,
                role, // 'user' or 'assistant'
                text,
                ...(project_id ? { project_id } : {})
            };

            const insertedId = await AiHistoryModel.create(chatEntry);
            res.status(201).json({ message: 'Chat history stored', id: insertedId });
        } catch (error) {
            console.error('Error storing chat history:', error);
            res.status(500).json({ error: 'Failed to store chat history' });
        }
    }

    /**
     * Get chat history.
     * Always scoped to the requesting user's own messages.
     * projectId param is optional — if omitted, returns global (non-project) history.
     */
    static async getChatHistory(req, res) {
        try {
            const { projectId } = req.params;
            const userId = req.user._id;

            // If projectId is provided and not "global", validate project access
            if (projectId && projectId !== 'global') {
                const access = await AiHistoryController.validateProjectAccess(projectId, req.user);
                if (access.error) return res.status(403).json({ error: access.error });
            }

            const resolvedProjectId = (projectId && projectId !== 'global') ? projectId : null;
            const history = await AiHistoryModel.findByUser(userId, resolvedProjectId);
            res.json({ history });
        } catch (error) {
            console.error('Error fetching chat history:', error);
            res.status(500).json({ error: 'Failed to fetch chat history' });
        }
    }
}

module.exports = AiHistoryController;
