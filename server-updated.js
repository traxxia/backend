const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const fetch = require('node-fetch'); // Add this for ML API calls
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;
const secretKey = process.env.SECRET_KEY || 'default_secret_key';

app.use(bodyParser.json());
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_multi_tenant'; 
let db;

// Permission helper functions
const canAnswerQuestions = (userRole) => {
  return userRole.can_answer || userRole.role_name === 'super_admin' || userRole.role_name === 'company_admin';
};

const canViewQuestions = (userRole) => {
  return userRole.can_view || userRole.role_name === 'super_admin' || userRole.role_name === 'company_admin';
};

async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();
    console.log('✅ Connected to MongoDB');

    await createEssentialIndexes();
    await initializeSystem();

  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

// Create essential indexes for performance
async function createEssentialIndexes() {
  try {
    // Users indexes
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ role_id: 1, company_id: 1 });

    // Questions indexes
    await db.collection('global_questions').createIndex({ question_id: 1 }, { unique: true });
    await db.collection('company_questions').createIndex({ company_id: 1, global_question_id: 1 });

    // Progress tracking indexes
    await db.collection('user_progress').createIndex({ user_id: 1, company_id: 1, question_id: 1, is_followup: 1 });
    await db.collection('user_progress').createIndex({ user_id: 1, company_id: 1, answered_at: 1 });
    await db.collection('user_progress').createIndex({ followup_parent_id: 1 });
    
    // Chat history indexes
    await db.collection('user_chat_history').createIndex({ user_id: 1, company_id: 1, timestamp: 1 });
    await db.collection('user_chat_history').createIndex({ user_id: 1, company_id: 1, question_id: 1 });

    console.log('✅ Essential indexes created');
  } catch (error) {
    console.log('ℹ️ Some indexes may already exist');
  }
}

// Initialize system with default roles and super admin
async function initializeSystem() {
  try {
    // Create default roles if they don't exist
    const existingRoles = await db.collection('roles').find({}).toArray();
    if (existingRoles.length === 0) {
      const defaultRoles = [
        {
          role_name: 'super_admin',
          permissions: ['manage_all', 'create_companies', 'manage_global_questions', 'view_all_data'],
          can_view: true,
          can_answer: true,
          can_admin: true,
          created_at: new Date()
        },
        {
          role_name: 'company_admin',
          permissions: ['manage_company_users', 'view_company_data', 'customize_questions'],
          can_view: true,
          can_answer: true,
          can_admin: true,
          created_at: new Date()
        },
        {
          role_name: 'viewer_user',
          permissions: ['view_application'],
          can_view: true,
          can_answer: false,
          can_admin: false,
          created_at: new Date()
        },
        {
          role_name: 'answerer_user',
          permissions: ['answer_questions', 'view_own_results'],
          can_view: true,
          can_answer: true,
          can_admin: false,
          created_at: new Date()
        }
      ];

      await db.collection('roles').insertMany(defaultRoles);
      console.log('✅ Default roles created');
    }

    // Create super admin if doesn't exist
    const superAdminRole = await db.collection('roles').findOne({ role_name: 'super_admin' });
    const existingSuperAdmin = await db.collection('users').findOne({ role_id: superAdminRole._id });

    if (!existingSuperAdmin) {
      const defaultPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin123!';
      const hashedPassword = await bcrypt.hash(defaultPassword, 12);

      await db.collection('users').insertOne({
        name: 'Super Administrator',
        email: 'superadmin@traxxia.com',
        password: hashedPassword,
        role_id: superAdminRole._id,
        company_id: null,
        status: 'active',
        profile: { job_title: 'Super Administrator' },
        created_at: new Date(),
        last_login: null
      });

      console.log('✅ Super Admin created');
      console.log(`📧 Email: superadmin@traxxia.com`);
      console.log(`🔑 Password: ${defaultPassword}`);
    }

  } catch (error) {
    console.error('❌ System initialization error:', error);
  }
}

// ===============================
// MIDDLEWARE
// ===============================

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).send({ message: 'No token provided' });

  jwt.verify(token, secretKey, async (err, decoded) => {
    if (err) return res.status(403).send({ message: 'Invalid token' });

    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.id) });
    if (!user) return res.status(403).send({ message: 'User not found' });

    const role = await db.collection('roles').findOne({ _id: user.role_id });
    if (!role) return res.status(403).send({ message: 'Role not found' });

    req.user = { ...user, role };
    next();
  });
};

// Super Admin middleware
const requireSuperAdmin = (req, res, next) => {
  if (req.user.role.role_name !== 'super_admin') {
    return res.status(403).send({ message: 'Super Admin access required' });
  }
  next();
};

// Company Admin middleware
const requireCompanyAdmin = (req, res, next) => {
  if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
    return res.status(403).send({ message: 'Admin access required' });
  }
  next();
};

// ===============================
// AUTHENTICATION APIs
// ===============================

// Login API
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).send({ message: 'Email and password are required' });
    }

    const user = await db.collection('users').findOne({ email });
    if (!user) {
      return res.status(400).send({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).send({ message: 'Invalid credentials' });
    }

    const role = await db.collection('roles').findOne({ _id: user.role_id });
    let company = null;
    if (user.company_id) {
      company = await db.collection('companies').findOne({ _id: user.company_id });
    }

    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { last_login: new Date() } }
    );

    const token = jwt.sign({
      id: user._id,
      email: user.email,
      role: role.role_name,
      company_id: user.company_id
    }, secretKey, { expiresIn: '24h' });

    res.status(200).send({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: role.role_name,
        company: company ? company.company_name : null,
        permissions: role.permissions
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// SIMPLIFIED USER PROGRESS TRACKING
// ===============================

// Get User's Latest Progress and Chat History
app.get('/api/user/latest-progress', authenticateToken, async (req, res) => {
  try {
    if (!canViewQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to view progress' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    // Get all user's answers/progress (only main answers, not followup)
    const userProgress = await db.collection('user_progress').find({
      user_id: userId,
      company_id: companyId,
      is_followup: false  // Only get main answers for userAnswers map
    }).sort({ answered_at: 1 }).toArray();

    // Get chat history
    const chatHistory = await db.collection('user_chat_history').find({
      user_id: userId,
      company_id: companyId
    }).sort({ timestamp: 1 }).toArray();

    // Get available questions for context
    let availableQuestions = [];
    if (req.user.role.role_name === 'super_admin') {
      // For super admin, get global questions
      availableQuestions = await db.collection('global_questions').find({
        is_active: true
      }).sort({ order: 1, question_id: 1 }).toArray();
    } else {
      // For company users, get company-specific questions
      availableQuestions = await db.collection('company_questions').aggregate([
        { $match: { company_id: companyId, is_active: true } },
        {
          $lookup: {
            from: 'global_questions',
            localField: 'global_question_id',
            foreignField: '_id',
            as: 'global_question'
          }
        },
        { $unwind: '$global_question' },
        {
          $project: {
            question_id: '$global_question.question_id',
            question_text: {
              $cond: {
                if: '$is_customized',
                then: '$custom_question_text',
                else: '$global_question.question_text'
              }
            },
            phase: '$global_question.phase',
            severity: '$global_question.severity',
            order: '$global_question.order'
          }
        },
        { $sort: { order: 1, question_id: 1 } }
      ]).toArray();
    }

    // Build user answers map from main answers only
    const userAnswers = {};
    userProgress.forEach(progress => {
      userAnswers[progress.question_id] = progress.answer_text;
    });

    // Find next question to ask
    const answeredQuestionIds = Object.keys(userAnswers).map(id => parseInt(id));
    const nextQuestion = availableQuestions.find(q => !answeredQuestionIds.includes(q.question_id));

    // Calculate progress
    const totalQuestions = availableQuestions.length;
    const answeredQuestions = answeredQuestionIds.length;
    const progressPercentage = totalQuestions > 0 ? Math.round((answeredQuestions / totalQuestions) * 100) : 0;

    console.log('📊 Latest progress loaded:', {
      total_questions: totalQuestions,
      answered_questions: answeredQuestions,
      next_question: nextQuestion?.question_id,
      chat_messages: chatHistory.length
    });

    res.status(200).send({
      user_answers: userAnswers,
      chat_history: chatHistory,
      available_questions: availableQuestions,
      next_question: nextQuestion,
      progress: {
        total_questions: totalQuestions,
        answered_questions: answeredQuestions,
        completion_percentage: progressPercentage
      },
      user_permissions: {
        can_view: canViewQuestions(req.user.role),
        can_answer: canAnswerQuestions(req.user.role),
        can_admin: req.user.role.can_admin || req.user.role.role_name === 'super_admin',
        role: req.user.role.role_name
      }
    });

  } catch (error) {
    console.error('Get latest progress error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});
 // Add this new API endpoint to your backend code

// Get User Data with Chat History - Single comprehensive endpoint
app.get('/api/admin/user-data/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserRole = req.user.role.role_name;
    const requestingUserCompanyId = req.user.company_id;

    // Authorization check
    if (!['super_admin', 'company_admin'].includes(requestingUserRole)) {
      return res.status(403).send({ message: 'Admin access required' });
    }

    // Validate userId
    if (!ObjectId.isValid(userId)) {
      return res.status(400).send({ message: 'Invalid user ID' });
    }

    const targetUserId = new ObjectId(userId);

    // Get target user details
    const targetUser = await db.collection('users').aggregate([
      { $match: { _id: targetUserId } },
      {
        $lookup: {
          from: 'roles',
          localField: 'role_id',
          foreignField: '_id',
          as: 'role'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      {
        $unwind: { path: '$role', preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: '$company', preserveNullAndEmptyArrays: true }
      }
    ]).toArray();

    if (targetUser.length === 0) {
      return res.status(404).send({ message: 'User not found' });
    }

    const user = targetUser[0];

    // Company admin can only view users from their own company
    if (requestingUserRole === 'company_admin') {
      if (!user.company_id || user.company_id.toString() !== requestingUserCompanyId.toString()) {
        return res.status(403).send({ message: 'You can only view users from your company' });
      }
    }

    // Get user's answers/progress
    const answers = await db.collection('user_progress').find({
      user_id: targetUserId,
      company_id: user.company_id
    }).sort({ answered_at: 1 }).toArray();

    // Get user's chat history
    const chatHistory = await db.collection('user_chat_history').find({
      user_id: targetUserId,
      company_id: user.company_id
    }).sort({ timestamp: 1 }).toArray();

    // Get user's phase results if any
    const phaseResults = await db.collection('phase_results').find({
      user_id: targetUserId,
      company_id: user.company_id
    }).sort({ generated_at: -1 }).toArray();

    // Get user's sessions
    const sessions = await db.collection('user_sessions').find({
      user_id: targetUserId,
      company_id: user.company_id
    }).sort({ started_at: -1 }).toArray();

    // Calculate summary statistics
    const totalAnswers = answers.length;
    const mainAnswers = answers.filter(a => !a.is_followup).length;
    const followupAnswers = answers.filter(a => a.is_followup).length;
    const completedPhases = [...new Set(answers.map(a => a.phase))].length;
    const totalSessions = sessions.length;
    const activeSessions = sessions.filter(s => s.status === 'active').length;

    // Group chat history by conversation/question for better organization
    const chatByQuestion = {};
    chatHistory.forEach(chat => {
      const key = chat.question_id || 'general';
      if (!chatByQuestion[key]) {
        chatByQuestion[key] = [];
      }
      chatByQuestion[key].push(chat);
    });

    // Organize answers with their related chat messages
    const answersWithChat = answers.map(answer => {
      const relatedChat = chatByQuestion[answer.question_id] || [];
      return {
        ...answer,
        related_chat_messages: relatedChat.filter(chat => 
          Math.abs(new Date(chat.timestamp) - new Date(answer.answered_at)) < 30 * 60 * 1000 // Within 30 minutes
        )
      };
    });

    console.log(`📊 User data loaded for ${user.name}:`, {
      total_answers: totalAnswers,
      chat_messages: chatHistory.length,
      phase_results: phaseResults.length,
      sessions: totalSessions
    });

    res.status(200).send({
      user_info: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role?.role_name || 'unknown',
        company: user.company?.company_name || 'No Company',
        status: user.status,
        created_at: user.created_at,
        last_login: user.last_login,
        profile: user.profile
      },
      summary: {
        total_answers: totalAnswers,
        main_answers: mainAnswers,
        followup_answers: followupAnswers,
        completed_phases: completedPhases,
        total_sessions: totalSessions,
        active_sessions: activeSessions,
        total_chat_messages: chatHistory.length,
        first_activity: answers.length > 0 ? answers[0].answered_at : null,
        last_activity: answers.length > 0 ? answers[answers.length - 1].answered_at : null
      },
      answers: answersWithChat,
      chat_history: chatHistory,
      chat_by_question: chatByQuestion,
      phase_results: phaseResults,
      sessions: sessions,
      permissions: {
        can_export: true,
        can_view_details: true,
        requesting_user_role: requestingUserRole
      }
    });

  } catch (error) {
    console.error('Get user data error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Enhanced Company Admin Users endpoint to work with the frontend
app.get('/api/company-admin/users', authenticateToken, async (req, res) => {
  try {
    const requestingUserRole = req.user.role.role_name;
    const requestingUserCompanyId = req.user.company_id;
    const { company_id } = req.query;

    // Authorization check
    if (!['super_admin', 'company_admin'].includes(requestingUserRole)) {
      return res.status(403).send({ message: 'Admin access required' });
    }

    let query = {};
    let targetCompanyId = null;

    if (requestingUserRole === 'super_admin') {
      // Super admin can view all users or filter by company
      if (company_id) {
        targetCompanyId = new ObjectId(company_id);
        query.company_id = targetCompanyId;
      }
      // If no company_id specified, show all users
    } else if (requestingUserRole === 'company_admin') {
      // Company admin can only view their own company users
      targetCompanyId = requestingUserCompanyId;
      query.company_id = targetCompanyId;
    }

    // Get users with role and company information
    const users = await db.collection('users').aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'roles',
          localField: 'role_id',
          foreignField: '_id',
          as: 'role'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      {
        $unwind: { path: '$role', preserveNullAndEmptyArrays: true }
      },
      {
        $unwind: { path: '$company', preserveNullAndEmptyArrays: true }
      },
      {
        $project: {
          name: 1,
          email: 1,
          status: 1,
          created_at: 1,
          last_login: 1,
          profile: 1,
          role: {
            role_name: '$role.role_name',
            permissions: '$role.permissions'
          },
          company: {
            company_name: '$company.company_name',
            _id: '$company._id'
          }
        }
      },
      { $sort: { created_at: -1 } }
    ]).toArray();

    // Get activity summary for each user
    const usersWithActivity = await Promise.all(
      users.map(async (user) => {
        const [answerCount, chatCount, sessionCount] = await Promise.all([
          db.collection('user_progress').countDocuments({ user_id: user._id }),
          db.collection('user_chat_history').countDocuments({ user_id: user._id }),
          db.collection('user_sessions').countDocuments({ user_id: user._id })
        ]);

        return {
          ...user,
          activity_summary: {
            total_answers: answerCount,
            total_chat_messages: chatCount,
            total_sessions: sessionCount,
            has_activity: answerCount > 0 || chatCount > 0
          }
        };
      })
    );

    console.log(`📋 Retrieved ${usersWithActivity.length} users for ${requestingUserRole}`);

    res.status(200).send({
      users: usersWithActivity,
      total: usersWithActivity.length,
      filters: {
        company_id: targetCompanyId,
        requesting_user_role: requestingUserRole
      }
    });

  } catch (error) {
    console.error('Get company users error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});
app.post('/api/user/save-answer', authenticateToken, async (req, res) => {
  try {
    if (!canAnswerQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to submit answers' });
    }

    const { question_id, question_text, answer_text, is_followup = false, followup_parent_id = null } = req.body;

    if (!question_id || !question_text || !answer_text) {
      return res.status(400).send({ message: 'Question ID, text, and answer are required' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    console.log('💾 Saving answer:', {
      question_id,
      is_followup,
      answer_length: answer_text.length,
      user: req.user.email
    });

    // Save the answer
    const existingProgress = await db.collection('user_progress').findOne({
      user_id: userId,
      company_id: companyId,
      question_id: parseInt(question_id),
      is_followup: is_followup,
      followup_parent_id: followup_parent_id
    });

    let progressId;
    if (existingProgress) {
      // Update existing answer
      await db.collection('user_progress').updateOne(
        { _id: existingProgress._id },
        {
          $set: {
            answer_text: answer_text.trim(),
            answered_at: new Date(),
            attempt_count: (existingProgress.attempt_count || 1) + 1
          }
        }
      );
      progressId = existingProgress._id;
      console.log('📝 Updated existing answer');
    } else {
      // Create new progress entry
      const result = await db.collection('user_progress').insertOne({
        user_id: userId,
        company_id: companyId,
        question_id: parseInt(question_id),
        question_text: question_text,
        answer_text: answer_text.trim(),
        is_followup: is_followup,
        followup_parent_id: followup_parent_id,
        attempt_count: 1,
        answered_at: new Date()
      });
      progressId = result.insertedId;
      console.log('✨ Created new answer');
    }

    // Return success without ML validation (frontend will handle ML API call)
    res.status(200).send({
      message: 'Answer saved successfully',
      question_id: parseInt(question_id),
      is_followup: is_followup,
      is_update: !!existingProgress,
      progress_id: progressId
    });

  } catch (error) {
    console.error('Save answer error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Save Chat Message (simplified)
app.post('/api/user/save-chat-message', authenticateToken, async (req, res) => {
  try {
    const { message_type, message_text, question_id = null, metadata = {} } = req.body;

    if (!message_type || !message_text) {
      return res.status(400).send({ message: 'Message type and text are required' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    await db.collection('user_chat_history').insertOne({
      user_id: userId,
      company_id: companyId,
      message_type: message_type, // 'user', 'bot', 'system'
      message_text: message_text,
      question_id: question_id ? parseInt(question_id) : null,
      timestamp: new Date(),
      metadata: metadata
    });

    res.status(200).send({ message: 'Chat message saved successfully' });

  } catch (error) {
    console.error('Save chat message error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get Complete Conversation History (including followups)
app.get('/api/user/conversation-history', authenticateToken, async (req, res) => {
  try {
    if (!canViewQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to view conversation history' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    // Get all progress entries (main answers + followups)
    const allProgress = await db.collection('user_progress').find({
      user_id: userId,
      company_id: companyId
    }).sort({ answered_at: 1 }).toArray();

    // Get chat history
    const chatHistory = await db.collection('user_chat_history').find({
      user_id: userId,
      company_id: companyId
    }).sort({ timestamp: 1 }).toArray();

    // Organize progress by question with followups
    const conversationMap = {};
    
    allProgress.forEach(progress => {
      const key = progress.question_id;
      
      if (!conversationMap[key]) {
        conversationMap[key] = {
          question_id: progress.question_id,
          question_text: progress.question_text,
          main_answer: null,
          followup_answers: [],
          answered_at: progress.answered_at
        };
      }
      
      if (progress.is_followup) {
        conversationMap[key].followup_answers.push({
          answer_text: progress.answer_text,
          answered_at: progress.answered_at,
          attempt_count: progress.attempt_count,
          followup_parent_id: progress.followup_parent_id
        });
      } else {
        conversationMap[key].main_answer = {
          answer_text: progress.answer_text,
          answered_at: progress.answered_at,
          attempt_count: progress.attempt_count
        };
      }
    });

    // Convert to sorted array
    const conversationHistory = Object.values(conversationMap)
      .sort((a, b) => a.question_id - b.question_id);

    res.status(200).send({
      conversation_history: conversationHistory,
      chat_messages: chatHistory,
      total_questions_answered: conversationHistory.length,
      total_followup_answers: allProgress.filter(p => p.is_followup).length
    });

  } catch (error) {
    console.error('Get conversation history error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get User Questions (from existing code)
app.get('/api/user/questions', authenticateToken, async (req, res) => {
  try {
    if (!canViewQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to view questions' });
    }

    let questions = [];
    let targetCompanyId = null;
    let company = null;

    if (req.user.role.role_name === 'super_admin') {
      if (req.query.company_id) {
        targetCompanyId = new ObjectId(req.query.company_id);
        company = await db.collection('companies').findOne({ _id: targetCompanyId });

        if (!company) {
          return res.status(404).send({ message: 'Company not found' });
        }

        questions = await db.collection('company_questions').aggregate([
          { $match: { company_id: targetCompanyId, is_active: true } },
          {
            $lookup: {
              from: 'global_questions',
              localField: 'global_question_id',
              foreignField: '_id',
              as: 'global_question'
            }
          },
          { $unwind: '$global_question' },
          {
            $project: {
              question_id: '$global_question.question_id',
              question_text: {
                $cond: {
                  if: '$is_customized',
                  then: '$custom_question_text',
                  else: '$global_question.question_text'
                }
              },
              phase: '$global_question.phase',
              severity: '$global_question.severity',
              order: '$global_question.order'
            }
          },
          { $sort: { order: 1, question_id: 1 } }
        ]).toArray();
      } else {
        const globalQuestions = await db.collection('global_questions').aggregate([
          { $match: { is_active: true } },
          {
            $project: {
              question_id: 1,
              question_text: 1,
              phase: 1,
              severity: 1,
              order: 1
            }
          },
          { $sort: { order: 1, question_id: 1 } }
        ]).toArray();

        questions = globalQuestions;
        company = { id: 'global', name: 'Global Questions (Super Admin View)' };
      }
    } else {
      targetCompanyId = req.user.company_id;

      if (!targetCompanyId) {
        return res.status(400).send({ message: 'No company assigned to user' });
      }

      company = await db.collection('companies').findOne({ _id: targetCompanyId });

      questions = await db.collection('company_questions').aggregate([
        { $match: { company_id: targetCompanyId, is_active: true } },
        {
          $lookup: {
            from: 'global_questions',
            localField: 'global_question_id',
            foreignField: '_id',
            as: 'global_question'
          }
        },
        { $unwind: '$global_question' },
        {
          $project: {
            question_id: '$global_question.question_id',
            question_text: {
              $cond: {
                if: '$is_customized',
                then: '$custom_question_text',
                else: '$global_question.question_text'
              }
            },
            phase: '$global_question.phase',
            severity: '$global_question.severity',
            order: '$global_question.order'
          }
        },
        { $sort: { order: 1, question_id: 1 } }
      ]).toArray();
    }

    res.status(200).send({
      questions,
      total: questions.length,
      company: company ? {
        id: company.id || company._id,
        name: company.name || company.company_name
      } : null,
      user_permissions: {
        can_view: canViewQuestions(req.user.role),
        can_answer: canAnswerQuestions(req.user.role),
        can_admin: req.user.role.can_admin || req.user.role.role_name === 'super_admin',
        role: req.user.role.role_name
      }
    });
  } catch (error) {
    console.error('Get user questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Clear User Progress (optional - for starting fresh)
app.delete('/api/user/clear-progress', authenticateToken, async (req, res) => {
  try {
    if (!canAnswerQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to clear progress' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    await Promise.all([
      db.collection('user_progress').deleteMany({ user_id: userId, company_id: companyId }),
      db.collection('user_chat_history').deleteMany({ user_id: userId, company_id: companyId })
    ]);

    res.status(200).send({ message: 'Progress cleared successfully' });

  } catch (error) {
    console.error('Clear progress error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// HEALTH CHECK
// ===============================

app.get('/health', async (req, res) => {
  try {
    const dbStatus = db ? 'Connected' : 'Disconnected';

    const [companies, users, questions, progressEntries] = await Promise.all([
      db ? db.collection('companies').estimatedDocumentCount() : 0,
      db ? db.collection('users').estimatedDocumentCount() : 0,
      db ? db.collection('global_questions').estimatedDocumentCount() : 0,
      db ? db.collection('user_progress').estimatedDocumentCount() : 0
    ]);

    res.status(200).send({
      message: 'Simplified Traxxia API is running 🚀',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      statistics: { 
        companies, 
        users, 
        global_questions: questions, 
        user_progress: progressEntries 
      },
      architecture: 'Simplified progress tracking with ML validation',
      features: ['ML-powered followup questions', 'Complete audit trail', 'Seamless resume']
    });
  } catch (error) {
    res.status(500).send({
      message: 'Health check failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ===============================
// SUPER ADMIN - COMPANY MANAGEMENT
// ===============================

// Create Company
app.post('/api/super-admin/companies', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { company_name, industry, size, admin_name, admin_email, admin_password } = req.body;

    if (!company_name || !admin_name || !admin_email || !admin_password) {
      return res.status(400).send({ message: 'Company name and admin details are required' });
    }

    const existingUser = await db.collection('users').findOne({ email: admin_email });
    if (existingUser) {
      return res.status(400).send({ message: 'Admin email already exists' });
    }

    const companyAdminRole = await db.collection('roles').findOne({ role_name: 'company_admin' });

    const newCompany = {
      company_name,
      industry: industry || '',
      size: size || '',
      status: 'active',
      created_at: new Date()
    };

    const companyResult = await db.collection('companies').insertOne(newCompany);

    const hashedPassword = await bcrypt.hash(admin_password, 12);
    const newAdmin = {
      name: admin_name,
      email: admin_email,
      password: hashedPassword,
      role_id: companyAdminRole._id,
      company_id: companyResult.insertedId,
      status: 'active',
      profile: { job_title: 'Company Administrator' },
      created_at: new Date(),
      last_login: null
    };

    const adminResult = await db.collection('users').insertOne(newAdmin);

    await db.collection('companies').updateOne(
      { _id: companyResult.insertedId },
      { $set: { admin_user_id: adminResult.insertedId } }
    );

    // Auto-assign all global questions to this company
    const globalQuestions = await db.collection('global_questions').find({ is_active: true }).toArray();
    const companyQuestions = globalQuestions.map(gq => ({
      company_id: companyResult.insertedId,
      global_question_id: gq._id,
      custom_question_text: null,
      is_customized: false,
      is_active: true,
      assigned_at: new Date(),
      assigned_by: new ObjectId(req.user._id)
    }));

    if (companyQuestions.length > 0) {
      await db.collection('company_questions').insertMany(companyQuestions);
    }

    res.status(201).send({
      message: 'Company and admin created successfully',
      company: {
        id: companyResult.insertedId,
        company_name,
        admin_email
      },
      questions_assigned: companyQuestions.length
    });
  } catch (error) {
    console.error('Create company error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// List All Companies
app.get('/api/super-admin/companies', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const companies = await db.collection('companies').aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'admin_user_id',
          foreignField: '_id',
          as: 'admin_user'
        }
      },
      {
        $unwind: { path: '$admin_user', preserveNullAndEmptyArrays: true }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: 'company_id',
          as: 'users'
        }
      },
      {
        $project: {
          company_name: 1,
          industry: 1,
          size: 1,
          status: 1,
          created_at: 1,
          admin_name: '$admin_user.name',
          admin_email: '$admin_user.email',
          total_users: { $size: '$users' },
          active_users: {
            $size: {
              $filter: {
                input: '$users',
                cond: { $eq: ['$this.status', 'active'] }
              }
            }
          }
        }
      }
    ]).toArray();

    res.status(200).send({
      companies,
      total: companies.length
    });
  } catch (error) {
    console.error('Get companies error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// SUPER ADMIN - GLOBAL QUESTIONS MANAGEMENT
// ===============================

// Create Global Question
app.post('/api/super-admin/global-questions', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { question_id, question_text, phase, severity, order } = req.body;

    if (!question_id || !question_text || !phase || !severity) {
      return res.status(400).send({ message: 'Question ID, text, phase, and severity are required' });
    }

    const existingQuestion = await db.collection('global_questions').findOne({ question_id });
    if (existingQuestion) {
      return res.status(400).send({ message: 'Question ID already exists' });
    }

    const newQuestion = {
      question_id,
      question_text,
      phase,
      severity,
      order: order || 999,
      is_active: true,
      created_at: new Date()
    };

    const result = await db.collection('global_questions').insertOne(newQuestion);

    // Auto-assign to all active companies
    const activeCompanies = await db.collection('companies').find({ status: 'active' }).toArray();
    const companyAssignments = activeCompanies.map(company => ({
      company_id: company._id,
      global_question_id: result.insertedId,
      custom_question_text: null,
      is_customized: false,
      is_active: true,
      assigned_at: new Date(),
      assigned_by: new ObjectId(req.user._id)
    }));

    if (companyAssignments.length > 0) {
      await db.collection('company_questions').insertMany(companyAssignments);
    }

    res.status(201).send({
      message: 'Global question created and assigned to all companies',
      question: { ...newQuestion, _id: result.insertedId },
      assigned_to_companies: companyAssignments.length
    });
  } catch (error) {
    console.error('Create global question error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// List Global Questions
app.get('/api/super-admin/global-questions', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questions = await db.collection('global_questions')
      .find({})
      .sort({ order: 1, question_id: 1 })
      .toArray();

    const questionsWithStats = await Promise.all(
      questions.map(async (question) => {
        const assignmentCount = await db.collection('company_questions').countDocuments({
          global_question_id: question._id
        });
        return { ...question, assigned_to_companies: assignmentCount };
      })
    );

    res.status(200).send({
      questions: questionsWithStats,
      total: questions.length
    });
  } catch (error) {
    console.error('Get global questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// COMPANY ADMIN - USER MANAGEMENT
// ===============================

// Create Company User
app.post('/api/company-admin/users', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    const { name, email, password, role_name, profile = {} } = req.body;

    if (!name || !email || !password || !role_name) {
      return res.status(400).send({ message: 'Name, email, password, and role are required' });
    }

    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).send({ message: 'Email already exists' });
    }

    const role = await db.collection('roles').findOne({ role_name });
    if (!role || !['viewer_user', 'answerer_user'].includes(role_name)) {
      return res.status(400).send({ message: 'Invalid role. Use viewer_user or answerer_user' });
    }

    const targetCompanyId = req.user.role.role_name === 'super_admin'
      ? new ObjectId(req.body.company_id)
      : req.user.company_id;

    if (!targetCompanyId) {
      return res.status(400).send({ message: 'Company ID required' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = {
      name,
      email,
      password: hashedPassword,
      role_id: role._id,
      company_id: targetCompanyId,
      status: 'active',
      profile,
      created_at: new Date(),
      last_login: null
    };

    const result = await db.collection('users').insertOne(newUser);

    res.status(201).send({
      message: 'User created successfully',
      user: {
        id: result.insertedId,
        name,
        email,
        role: role_name
      }
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.get('/api/roles', authenticateToken, async (req, res) => {
  try {
    // Optional: you can restrict access based on user role here
    const role = req.user.role.role_name;
    if (role !== 'super_admin' && role !== 'company_admin') {
      return res.status(403).send({ message: 'Access denied. Only super_admin or company_admin allowed.' });
    }

    const roles = await db.collection('roles').find().toArray();

    // Format roles if needed
    const formattedRoles = roles.map(r => ({
      id: r._id,
      role_name: r.role_name,
      description: r.description || '',
      created_at: r.created_at
    }));

    res.status(200).send({ roles: formattedRoles });
  } catch (error) {
    console.error('Fetch roles error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});


app.get('/api/admin/users', authenticateToken, async (req, res) => {
  try {
    const role = req.user.role.role_name;

    let query = {};

    if (role === 'company_admin') {
      query.company_id = req.user.company_id;
    } else if (role !== 'super_admin') {
      return res.status(403).send({ message: 'Access denied. Only super_admin or company_admin allowed.' });
    }

    const users = await db.collection('users').find(query).toArray();

    const roleMap = await db.collection('roles').find().toArray();
    const roleLookup = roleMap.reduce((acc, r) => {
      acc[r._id.toString()] = r.role_name;
      return acc;
    }, {});

    const formattedUsers = users.map(user => ({
      id: user._id,
      name: user.name,
      email: user.email,
      role: roleLookup[user.role_id?.toString()] || 'unknown',
      status: user.status,
      company_id: user.company_id,
      profile: user.profile,
      created_at: user.created_at,
      last_login: user.last_login
    }));

    res.status(200).send({ users: formattedUsers });
  } catch (error) {
    console.error('Fetch users error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});


// ===============================
// START SERVER
// ===============================

connectToMongoDB().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Simplified Traxxia API Server running on port ${port}`); 
    console.log(`📊 Features: Progress tracking with ML validation`);
    console.log(`💬 Audit Trail: Complete Q&A with followups`);
    console.log(`🔄 Resume: Seamless user experience`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});