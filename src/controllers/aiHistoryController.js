const { ObjectId } = require('mongodb');
const AiHistoryModel = require('../models/aiHistoryModel');
const ProjectModel = require('../models/projectModel');
const BusinessModel = require('../models/businessModel');

class AiHistoryController {
    /**
     * Helper: Validate project access
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
        const isAdmin = ['super_admin', 'company_admin'].includes(currentUser.role?.role_name);

        if (!isOwner && !isCollaborator && !isAdmin) {
            return { error: 'Not allowed to access history for this project' };
        }

        return { project, business };
    }

    static async storeChat(req, res) {
        try {
            const { project_id, role, text } = req.body;
            const userId = req.user._id;

            if (!project_id || !role || !text) {
                return res.status(400).json({ error: 'project_id, role, and text are required' });
            }

            const access = await AiHistoryController.validateProjectAccess(project_id, req.user);
            if (access.error) return res.status(403).json({ error: access.error });

            const chatEntry = {
                project_id,
                user_id: userId,
                role, // 'user' or 'assistant'
                text
            };

            const insertedId = await AiHistoryModel.create(chatEntry);
            res.status(201).json({ message: 'Chat history stored', id: insertedId });
        } catch (error) {
            console.error('Error storing chat history:', error);
            res.status(500).json({ error: 'Failed to store chat history' });
        }
    }

    static async getChatHistory(req, res) {
        try {
            const { projectId } = req.params;

            if (!projectId) {
                return res.status(400).json({ error: 'projectId is required' });
            }

            const access = await AiHistoryController.validateProjectAccess(projectId, req.user);
            if (access.error) return res.status(403).json({ error: access.error });

            const history = await AiHistoryModel.findByProjectAndUser(projectId, req.user._id);
            res.json({ history });
        } catch (error) {
            console.error('Error fetching chat history:', error);
            res.status(500).json({ error: 'Failed to fetch chat history' });
        }
    }
}

module.exports = AiHistoryController;
