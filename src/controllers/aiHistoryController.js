const { ObjectId } = require('mongodb');
const AiHistoryModel = require('../models/aiHistoryModel');
const ProjectModel = require('../models/projectModel');
const BusinessModel = require('../models/businessModel');
const AiChatLogModel = require('../models/aiChatLogModel');
const { isObservatoryRequest } = require('../utils/isObservatoryRequest');

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
        const isSuperAdmin = currentUser.role?.role_name === 'super_admin';

        // Allow access if owner, collaborator, or super admin
        if (!isOwner && !isCollaborator && !isSuperAdmin) {
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

            // If projectId is provided and is a specific ID (not "global" or "all"), validate project access
            if (projectId && !['global', 'all'].includes(projectId)) {
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
    /**
     * Clear chat history.
     */
    static async clearChatHistory(req, res) {
        try {
            const { projectId } = req.params;
            const userId = req.user._id;

            // If projectId is provided and is a specific ID (not "global" or "all"), validate project access
            if (projectId && !['global', 'all'].includes(projectId)) {
                const access = await AiHistoryController.validateProjectAccess(projectId, req.user);
                if (access.error) return res.status(403).json({ error: access.error });
            }

            const result = await AiHistoryModel.clearHistory(userId, projectId);
            res.json({ message: 'Chat history cleared', deletedCount: result.deletedCount });
        } catch (error) {
            console.error('Error clearing chat history:', error);
            res.status(500).json({ error: 'Failed to clear chat history' });
        }
    }
    /**
     * Log a full AI chat turn (system prompt + user input + assistant response).
     * GATED: Only writes to ai_chat_logs if the request is from the Observatory Account.
     * For all other users, responds 204 No Content immediately — zero overhead.
     */
    static async logTurn(req, res) {
        // ✅ GATE: Silently discard for non-observatory users
        if (!isObservatoryRequest(req)) {
            return res.status(204).end();
        }

        try {
            const {
                user_input, system_prompt, assistant_response,
                business_id, project_id, page_context,
                token_usage, latency_ms, model, status, timestamp
            } = req.body;

            // Resolve names from DB for easier filtering in Observatory UI
            const [business, project] = await Promise.all([
                business_id ? BusinessModel.findById(business_id) : Promise.resolve(null),
                project_id ? ProjectModel.findById(project_id) : Promise.resolve(null)
            ]);

            // Fire-and-forget — respond immediately, write in background
            AiChatLogModel.create({
                observatory_account_id: req.user._id,
                business_id: business_id || null,
                business_name: business?.business_name || null,
                project_id: project_id || null,
                project_name: project?.project_name || null,
                page_context: page_context || null,
                system_prompt: system_prompt || null,
                user_input: user_input || null,
                assistant_response: assistant_response || null,
                llm_provider: 'mastra',
                model: model || null,
                token_usage: token_usage || null,
                latency_ms: latency_ms || null,
                status: status || 'success',
                timestamp: timestamp || new Date().toISOString()
            }).catch((err) => {
                console.error('[Observatory] Failed to write AI chat log:', err.message);
            });

            res.status(202).json({ ok: true });
        } catch (error) {
            console.error('Error in logTurn:', error);
            res.status(500).json({ error: 'Failed to log chat turn' });
        }
    }
}

module.exports = AiHistoryController;
