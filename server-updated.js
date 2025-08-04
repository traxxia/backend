const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;
const secretKey = process.env.SECRET_KEY || 'default_secret_key';

app.use(bodyParser.json());
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_multi_tenant'; 
let db;

// ===============================
// HELPER FUNCTIONS
// ===============================

// Permission helper functions
const canAnswerQuestions = (userRole) => {
  return userRole.can_answer || userRole.role_name === 'super_admin' || userRole.role_name === 'company_admin';
};

const canViewQuestions = (userRole) => {
  return userRole.can_view || userRole.role_name === 'super_admin' || userRole.role_name === 'company_admin';
};

async function getNextOrderInPhase(phase) {
  try {
    const lastQuestionInPhase = await db.collection('global_questions')
      .findOne({ phase }, { sort: { order: -1 } });
    
    return lastQuestionInPhase ? lastQuestionInPhase.order + 1 : 1;
  } catch (error) {
    console.error('Error getting next order in phase:', error);
    const count = await db.collection('global_questions').countDocuments({ phase });
    return count + 1;
  }
}

async function getNextOrdersForPhases(questionsGroupedByPhase) {
  const phaseOrders = {};
  
  for (const phase of Object.keys(questionsGroupedByPhase)) {
    const lastQuestionInPhase = await db.collection('global_questions')
      .findOne({ phase }, { sort: { order: -1 } });
    
    phaseOrders[phase] = lastQuestionInPhase ? lastQuestionInPhase.order : 0;
  }
  
  return phaseOrders;
}

function validateQuestionData(question, index) {
  const errors = [];
  
  if (!question.question_text || typeof question.question_text !== 'string' || question.question_text.trim().length === 0) {
    errors.push(`Question ${index + 1}: question_text is required and must be a non-empty string`);
  }
  
  if (!question.phase || typeof question.phase !== 'string' || question.phase.trim().length === 0) {
    errors.push(`Question ${index + 1}: phase is required and must be a non-empty string`);
  }
  
  if (!question.severity || typeof question.severity !== 'string' || question.severity.trim().length === 0) {
    errors.push(`Question ${index + 1}: severity is required and must be a non-empty string`);
  }
  
  if (question.order !== undefined) {
    if (!Number.isInteger(question.order) || question.order < 1) {
      errors.push(`Question ${index + 1}: order must be a positive integer if provided`);
    }
  }
  
  return errors;
}

// ===============================
// DATABASE CONNECTION & SETUP
// ===============================

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

async function createEssentialIndexes() {
  try {
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('users').createIndex({ role_id: 1, company_id: 1 });
    await db.collection('global_questions').createIndex({ phase: 1, order: 1 });
    await db.collection('company_questions').createIndex({ company_id: 1, global_question_id: 1 });
    await db.collection('user_progress').createIndex({ user_id: 1, company_id: 1, question_id: 1, is_followup: 1 });
    await db.collection('user_progress').createIndex({ user_id: 1, company_id: 1, answered_at: 1 });
    await db.collection('user_chat_history').createIndex({ user_id: 1, company_id: 1, timestamp: 1 });
    await db.collection('user_chat_history').createIndex({ user_id: 1, company_id: 1, question_id: 1 });

    console.log('✅ Essential indexes created');
  } catch (error) {
    console.log('ℹ️ Some indexes may already exist');
  }
}

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

const requireSuperAdmin = (req, res, next) => {
  if (req.user.role.role_name !== 'super_admin') {
    return res.status(403).send({ message: 'Super Admin access required' });
  }
  next();
};

const requireCompanyAdmin = (req, res, next) => {
  if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
    return res.status(403).send({ message: 'Admin access required' });
  }
  next();
};

// ===============================
// AUTHENTICATION APIs
// ===============================

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
// USER PROGRESS & QUESTIONS APIs
// ===============================
function getQuestionOrderById(questions, questionId) {
  const question = questions.find(q => q._id.toString() === questionId.toString());
  return question ? question.order : null;
}

function getQuestionPhaseById(questions, questionId) {
  const question = questions.find(q => q._id.toString() === questionId.toString());
  return question ? question.phase : null;
}

function getQuestionSeverityById(questions, questionId) {
  const question = questions.find(q => q._id.toString() === questionId.toString());
  return question ? question.severity : null;
}

function extractBusinessName(finalAnswers) {
  // Extract business name from the first answer
  const firstAnswer = finalAnswers['1']?.finalAnswer || '';
  
  // Try to extract company name patterns
  const namePatterns = [
    /(?:We are|I am|Our company is|The company is)\s+([^,]+)/i,
    /^([^,]+),/,
    /^([^.]+)\./
  ];
  
  for (const pattern of namePatterns) {
    const match = firstAnswer.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  // Fallback: take first few words
  const words = firstAnswer.split(' ').slice(0, 3);
  return words.join(' ') || 'Unknown Company';
}
app.get('/api/user/latest-progress', authenticateToken, async (req, res) => {
  try {
    if (!canViewQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to view progress' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    // Get user progress (answers)
    const userProgress = await db.collection('user_progress').find({
      user_id: userId,
      company_id: companyId,
      is_followup: false
    }).sort({ answered_at: 1 }).toArray();

    // Get chat history
    const chatHistory = await db.collection('user_chat_history').find({
      user_id: userId,
      company_id: companyId
    }).sort({ timestamp: 1 }).toArray();

    // Get available questions
    let availableQuestions = [];
    if (req.user.role.role_name === 'super_admin') {
      availableQuestions = await db.collection('global_questions').find({
        is_active: true
      }).sort({ 
        order: 1,  // Primary sort by order ascending
        phase: 1, 
        _id: 1 
      }).toArray();
    } else {
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
            _id: '$global_question._id',
            question_text: {
              $cond: {
                if: '$is_customized',
                then: '$custom_question_text',
                else: '$global_question.question_text'
              }
            },
            phase: '$global_question.phase',
            severity: '$global_question.severity',
            order: '$global_question.order',
            is_active: '$global_question.is_active',
            created_at: '$global_question.created_at',
            bulk_upload: '$global_question.bulk_upload',
            uploaded_by: '$global_question.uploaded_by'
          }
        },
        {
          $sort: {
            order: 1,  // Primary sort by order ascending
            phase: 1,
            _id: 1
          }
        }
      ]).toArray();
    }

    // Additional defensive sort to ensure proper order
    availableQuestions.sort((a, b) => {
      // Primary: sort by order (ascending)
      const orderA = parseInt(a.order) || 0;
      const orderB = parseInt(b.order) || 0;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      
      // Secondary: sort by phase
      const phaseOrder = ['initial', 'essential', 'good', 'excellent'];
      const phaseA = phaseOrder.indexOf(a.phase);
      const phaseB = phaseOrder.indexOf(b.phase);
      if (phaseA !== phaseB) {
        return phaseA - phaseB;
      }
      
      // Tertiary: sort by _id as final tiebreaker
      return a._id.toString().localeCompare(b._id.toString());
    });

    // Build user answers map - question_id as string -> answer text
    const userAnswers = {};
    userProgress.forEach(progress => {
      userAnswers[progress.question_id.toString()] = progress.answer_text;
    });

    // Transform chat history to match desired format
    const transformedMessages = chatHistory.map(chat => ({
      id: chat._id.toString(),
      type: chat.message_type, // 'bot' or 'user'
      text: chat.message_text,
      timestamp: chat.timestamp,
      questionId: chat.question_id ? getQuestionOrderById(availableQuestions, chat.question_id) : null,
      phase: chat.metadata?.phase || 'initial',
      severity: chat.metadata?.severity || 'mandatory',
      isFollowUp: chat.metadata?.isFollowUp || false,
      isPhaseValidation: chat.metadata?.isPhaseValidation || false,
      mlValidation: {
        validated: chat.metadata?.mlValidation?.validated || false,
        attempt: chat.metadata?.mlValidation?.attempt || 1
      },
      _id: chat._id.toString()
    }));

    // Build final answers object - questionId as number -> answer details
    const finalAnswers = {};
    userProgress.forEach(progress => {
      const questionOrder = getQuestionOrderById(availableQuestions, progress.question_id);
      if (questionOrder) {
        finalAnswers[questionOrder.toString()] = {
          questionId: questionOrder,
          questionText: progress.question_text,
          finalAnswer: progress.answer_text,
          phase: getQuestionPhaseById(availableQuestions, progress.question_id) || 'initial',
          severity: getQuestionSeverityById(availableQuestions, progress.question_id) || 'mandatory',
          attemptCount: progress.attempt_count || 1,
          completedAt: progress.answered_at,
          _id: progress._id.toString()
        };
      }
    });

    // Calculate progress
    const totalQuestions = availableQuestions.length;
    const answeredQuestions = Object.keys(userAnswers).length;
    const progressPercentage = totalQuestions > 0 ? Math.round((answeredQuestions / totalQuestions) * 100) : 0;

    // Get mandatory questions for phase completion
    const mandatoryQuestions = availableQuestions.filter(q => q.severity === 'mandatory');
    const answeredMandatory = mandatoryQuestions.filter(q => 
      userAnswers.hasOwnProperty(q._id.toString())
    ).length;

    // Determine current phase and completed phases
    const phases = ['initial', 'essential', 'good', 'excellent'];
    let currentPhase = 'initial';
    const completedPhases = [];

    for (const phase of phases) {
      const phaseQuestions = availableQuestions.filter(q => q.phase === phase);
      const phaseMandatory = phaseQuestions.filter(q => q.severity === 'mandatory');
      const phaseAnswered = phaseMandatory.filter(q => 
        userAnswers.hasOwnProperty(q._id.toString())
      ).length;

      if (phaseMandatory.length > 0 && phaseAnswered === phaseMandatory.length) {
        completedPhases.push(phase);
      } else {
        currentPhase = phase;
        break;
      }
    }

    // Find next question
    const answeredQuestionIds = Object.keys(userAnswers);
    const nextQuestion = availableQuestions.find(q => !answeredQuestionIds.includes(q._id.toString()));

    // Build business data from answers
    const businessData = {
      name: extractBusinessName(finalAnswers),
      description: finalAnswers['1']?.finalAnswer || '',
      industry: finalAnswers['2']?.finalAnswer || '',
      targetAudience: finalAnswers['3']?.finalAnswer || '',
      products: finalAnswers['4']?.finalAnswer || ''
    };

    // Response in desired format
    res.status(200).send({
      messages: transformedMessages,
      finalAnswers: finalAnswers,
      progress: {
        totalQuestions: totalQuestions,
        mandatoryTotal: mandatoryQuestions.length,
        answeredQuestions: answeredQuestions,
        mandatoryAnswered: answeredMandatory,
        percentage: progressPercentage,
        currentPhase: currentPhase,
        completedPhases: completedPhases
      },
      businessData: businessData,
      lastActivity: userProgress.length > 0 ? userProgress[userProgress.length - 1].answered_at : new Date(),
      
      // Keep original structure for backward compatibility
      user_answers: userAnswers,
      chat_history: chatHistory,
      available_questions: availableQuestions,
      next_question: nextQuestion,
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
              _id: '$global_question._id',
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
          { $sort: { phase: 1, order: 1 } }
        ]).toArray();
      } else {
        questions = await db.collection('global_questions').find({
          is_active: true
        }).sort({ phase: 1, order: 1 }).toArray();

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
            _id: '$global_question._id',
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
        { $sort: { phase: 1, order: 1 } }
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
    const questionObjectId = new ObjectId(question_id);

    const existingProgress = await db.collection('user_progress').findOne({
      user_id: userId,
      company_id: companyId,
      question_id: questionObjectId,
      is_followup: is_followup,
      followup_parent_id: followup_parent_id
    });

    let progressId;
    if (existingProgress) {
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
    } else {
      const result = await db.collection('user_progress').insertOne({
        user_id: userId,
        company_id: companyId,
        question_id: questionObjectId,
        question_text: question_text,
        answer_text: answer_text.trim(),
        is_followup: is_followup,
        followup_parent_id: followup_parent_id,
        attempt_count: 1,
        answered_at: new Date()
      });
      progressId = result.insertedId;
    }

    res.status(200).send({
      message: 'Answer saved successfully',
      question_id: questionObjectId,
      is_followup: is_followup,
      is_update: !!existingProgress,
      progress_id: progressId
    });

  } catch (error) {
    console.error('Save answer error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

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
      message_type: message_type,
      message_text: message_text,
      question_id: question_id ? new ObjectId(question_id) : null,
      timestamp: new Date(),
      metadata: metadata
    });

    res.status(200).send({ message: 'Chat message saved successfully' });

  } catch (error) {
    console.error('Save chat message error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});
// ===============================
// USER CONVERSATION HISTORY API
// ===============================

app.get('/api/user/conversation-history', authenticateToken, async (req, res) => {
  try {
    if (!canViewQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to view conversation history' });
    }

    const userId = new ObjectId(req.user._id);
    const companyId = req.user.company_id;

    // Get all progress entries (main answers + followups) with proper ObjectId handling
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
      const key = progress.question_id.toString(); // Convert ObjectId to string for key
            
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
          attempt_count: progress.attempt_count || 1,
          followup_parent_id: progress.followup_parent_id
        });
        
        // Sort followup answers by answered_at
        conversationMap[key].followup_answers.sort((a, b) => 
          new Date(a.answered_at) - new Date(b.answered_at)
        );
      } else {
        conversationMap[key].main_answer = {
          answer_text: progress.answer_text,
          answered_at: progress.answered_at,
          attempt_count: progress.attempt_count || 1
        };
        
        // Update the main answered_at time
        conversationMap[key].answered_at = progress.answered_at;
      }
    });

    // Convert to sorted array - sort by answered_at chronologically
    const conversationHistory = Object.values(conversationMap)
      .sort((a, b) => new Date(a.answered_at) - new Date(b.answered_at));

    // Group chat history by question for easier reference
    const chatByQuestion = {};
    chatHistory.forEach(chat => {
      const questionKey = chat.question_id ? chat.question_id.toString() : 'general';
      if (!chatByQuestion[questionKey]) {
        chatByQuestion[questionKey] = [];
      }
      chatByQuestion[questionKey].push(chat);
    });

    // Calculate statistics
    const totalMainAnswers = conversationHistory.filter(conv => conv.main_answer).length;
    const totalFollowupAnswers = allProgress.filter(p => p.is_followup).length;
    const totalChatMessages = chatHistory.length;
    
    // Get first and last activity timestamps
    const firstActivity = allProgress.length > 0 ? allProgress[0].answered_at : null;
    const lastActivity = allProgress.length > 0 ? allProgress[allProgress.length - 1].answered_at : null;

    console.log(`📚 Conversation history retrieved for user ${req.user.email}: ${totalMainAnswers} main answers, ${totalFollowupAnswers} followups`);

    res.status(200).send({
      conversation_history: conversationHistory,
      chat_messages: chatHistory,
      chat_by_question: chatByQuestion,
      statistics: {
        total_questions_answered: totalMainAnswers,
        total_followup_answers: totalFollowupAnswers,
        total_chat_messages: totalChatMessages,
        total_conversations: conversationHistory.length,
        first_activity: firstActivity,
        last_activity: lastActivity
      },
      user_permissions: {
        can_view: canViewQuestions(req.user.role),
        can_answer: canAnswerQuestions(req.user.role),
        can_admin: req.user.role.can_admin || req.user.role.role_name === 'super_admin',
        role: req.user.role.role_name
      }
    });

  } catch (error) {
    console.error('Get conversation history error:', error);
    res.status(500).send({ 
      message: 'Server error', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});
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
// SUPER ADMIN - GLOBAL QUESTIONS
// ===============================

app.get('/api/super-admin/global-questions', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questions = await db.collection('global_questions')
      .find({})
      .sort({ phase: 1, order: 1, _id: 1 })
      .toArray();

    const questionsWithStats = await Promise.all(
      questions.map(async (question) => {
        const assignmentCount = await db.collection('company_questions').countDocuments({
          global_question_id: question._id
        });
        return { 
          ...question,
          assigned_to_companies: assignmentCount 
        };
      })
    );

    // Build questionsByPhase while maintaining order within each phase
    const questionsByPhase = questionsWithStats.reduce((acc, question) => {
      if (!acc[question.phase]) {
        acc[question.phase] = [];
      }
      acc[question.phase].push(question);
      return acc;
    }, {});

    // Sort each phase's questions by order (defensive programming)
    Object.keys(questionsByPhase).forEach(phase => {
      questionsByPhase[phase].sort((a, b) => {
        // Primary sort by order
        if (a.order !== b.order) {
          return (a.order || 0) - (b.order || 0);
        }
        // Secondary sort by _id if order is the same
        return a._id.toString().localeCompare(b._id.toString());
      });
    });

    res.status(200).send({
      questions: questionsWithStats,
      questionsByPhase,
      total: questions.length
    });
  } catch (error) {
    console.error('Get global questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.post('/api/super-admin/global-questions', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { question_text, phase, severity } = req.body;

    if (!question_text || !phase || !severity) {
      return res.status(400).send({ message: 'Question text, phase, and severity are required' });
    }

    const order = await getNextOrderInPhase(phase);

    const newQuestion = {
      question_text,
      phase,
      severity,
      order,
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
      question: { 
        _id: result.insertedId,
        ...newQuestion 
      },
      assigned_to_companies: companyAssignments.length
    });
  } catch (error) {
    console.error('Create global question error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.post('/api/super-admin/global-questions/bulk-upload', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).send({ 
        message: 'Questions array is required and must contain at least one question',
        expected_format: {
          questions: [
            {
              question_text: "What is your company's main challenge?",
              phase: "discovery",
              severity: "high",
              order: 1  // Optional
            }
          ]
        }
      });
    }

    if (questions.length > 100) {
      return res.status(400).send({ 
        message: 'Maximum 100 questions allowed per bulk upload' 
      });
    }

    // Validate all questions
    const allErrors = [];
    questions.forEach((question, index) => {
      const errors = validateQuestionData(question, index);
      allErrors.push(...errors);
    });

    if (allErrors.length > 0) {
      return res.status(400).send({ 
        message: 'Validation errors found',
        errors: allErrors,
        total_errors: allErrors.length
      });
    }
    
    // Group questions by phase
    const questionsByPhase = questions.reduce((acc, question) => {
      const phase = question.phase.trim();
      if (!acc[phase]) {
        acc[phase] = [];
      }
      acc[phase].push(question);
      return acc;
    }, {});

    const hasExplicitOrders = questions.some(q => q.order !== undefined);
    let questionsToInsert = [];
    const currentDate = new Date();

    if (hasExplicitOrders) {
      // Validate order conflicts
      const orderConflicts = [];
      Object.entries(questionsByPhase).forEach(([phase, phaseQuestions]) => {
        const ordersInPhase = phaseQuestions
          .filter(q => q.order !== undefined)
          .map(q => q.order);
        
        const duplicateOrders = ordersInPhase.filter((order, index) => 
          ordersInPhase.indexOf(order) !== index
        );
        
        if (duplicateOrders.length > 0) {
          orderConflicts.push(`Phase "${phase}" has duplicate orders: ${duplicateOrders.join(', ')}`);
        }
      });

      if (orderConflicts.length > 0) {
        return res.status(400).send({
          message: 'Order conflicts detected',
          errors: orderConflicts
        });
      }

      // Check for conflicts with existing questions
      for (const [phase, phaseQuestions] of Object.entries(questionsByPhase)) {
        const providedOrders = phaseQuestions
          .filter(q => q.order !== undefined)
          .map(q => q.order);
        
        if (providedOrders.length > 0) {
          const existingOrders = await db.collection('global_questions')
            .find({ phase, order: { $in: providedOrders } })
            .toArray();
          
          if (existingOrders.length > 0) {
            return res.status(400).send({
              message: `Order conflicts in phase "${phase}"`,
              conflicting_orders: existingOrders.map(q => ({
                order: q.order,
                existing_question: q.question_text
              }))
            });
          }
        }
      }

      // Prepare questions with explicit orders
      Object.entries(questionsByPhase).forEach(([phase, phaseQuestions]) => {
        phaseQuestions.forEach((question) => {
          questionsToInsert.push({
            question_text: question.question_text.trim(),
            phase: phase,
            severity: question.severity.trim(),
            order: question.order || null,
            is_active: true,
            created_at: currentDate,
            bulk_upload: true,
            uploaded_by: new ObjectId(req.user._id)
          });
        });
      });

      // Auto-assign orders for questions without explicit order
      const questionsNeedingOrder = questionsToInsert.filter(q => q.order === null);
      if (questionsNeedingOrder.length > 0) {
        const phaseOrders = await getNextOrdersForPhases(
          questionsNeedingOrder.reduce((acc, q) => {
            return acc;
          }, {})
        );

        questionsNeedingOrder.forEach(question => {
          question.order = ++phaseOrders[question.phase];
        });
      }
    } else {
      // Auto-assign all orders
      const phaseOrders = await getNextOrdersForPhases(questionsByPhase);

      Object.entries(questionsByPhase).forEach(([phase, phaseQuestions]) => {
        let currentOrder = phaseOrders[phase];
        
        phaseQuestions.forEach((question) => {
          currentOrder += 1;
          questionsToInsert.push({
            question_text: question.question_text.trim(),
            phase: phase,
            severity: question.severity.trim(),
            order: currentOrder,
            is_active: true,
            created_at: currentDate,
            bulk_upload: true,
            uploaded_by: new ObjectId(req.user._id)
          });
        });
      });
    }

    // Insert all questions
    const insertResult = await db.collection('global_questions').insertMany(questionsToInsert);
    const insertedQuestionIds = Object.values(insertResult.insertedIds);

    // Auto-assign to companies
    const activeCompanies = await db.collection('companies').find({ status: 'active' }).toArray();
    
    const companyAssignments = [];
    insertedQuestionIds.forEach(questionId => {
      activeCompanies.forEach(company => {
        companyAssignments.push({
          company_id: company._id,
          global_question_id: questionId,
          custom_question_text: null,
          is_customized: false,
          is_active: true,
          assigned_at: currentDate,
          assigned_by: new ObjectId(req.user._id),
          bulk_assigned: true
        });
      });
    });

    if (companyAssignments.length > 0) {
      await db.collection('company_questions').insertMany(companyAssignments);
    }

    const phaseStats = Object.entries(questionsByPhase).map(([phase, phaseQuestions]) => ({
      phase,
      count: phaseQuestions.length
    }));

    console.log(`📚 Bulk upload completed: ${questionsToInsert.length} questions uploaded by ${req.user.email}`);

    res.status(201).send({
      message: 'Bulk upload completed successfully',
      summary: {
        total_questions_uploaded: questionsToInsert.length,
        total_companies_assigned: activeCompanies.length,
        total_assignments_created: companyAssignments.length,
        phases_affected: Object.keys(questionsByPhase).length
      },
      phase_breakdown: phaseStats,
      uploaded_questions: insertedQuestionIds.map((id, index) => ({
        _id: id,
        question_text: questionsToInsert[index].question_text,
        phase: questionsToInsert[index].phase,
        severity: questionsToInsert[index].severity,
        order: questionsToInsert[index].order
      })),
      company_assignments: {
        successful: companyAssignments.length,
        companies_affected: activeCompanies.map(c => ({
          id: c._id,
          name: c.company_name
        }))
      }
    });

  } catch (error) {
    console.error('Bulk upload global questions error:', error);
    
    if (error.code === 11000) {
      return res.status(400).send({ 
        message: 'Duplicate question detected',
        error: 'One or more questions already exist in the database' 
      });
    }
    
    res.status(500).send({ 
      message: 'Server error during bulk upload', 
      error: error.message 
    });
  }
});
app.put('/api/super-admin/global-questions/reorder', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { phase, questionOrders } = req.body;

    // Validate input
    if (!phase || !questionOrders || !Array.isArray(questionOrders)) {
      return res.status(400).send({ 
        message: 'Phase and questionOrders array are required' 
      });
    }

    if (questionOrders.length === 0) {
      return res.status(400).send({ 
        message: 'questionOrders cannot be empty' 
      });
    }

    // Validate that all questionOrders have id and order
    const invalidOrders = questionOrders.filter(item => 
      !item.id || typeof item.order !== 'number' || item.order < 1
    );

    if (invalidOrders.length > 0) {
      return res.status(400).send({ 
        message: 'All questionOrders must have valid id and positive order number' 
      });
    }

    // Convert string IDs to ObjectIds and verify questions exist
    const questionIds = questionOrders.map(item => {
      try {
        return new ObjectId(item.id);
      } catch (error) {
        throw new Error(`Invalid ObjectId: ${item.id}`);
      }
    });

    // Verify all questions exist and belong to the specified phase
    const existingQuestions = await db.collection('global_questions').find({
      _id: { $in: questionIds },
      phase: phase
    }).toArray();

    if (existingQuestions.length !== questionOrders.length) {
      return res.status(400).send({ 
        message: `Some questions not found or do not belong to phase "${phase}". Found ${existingQuestions.length} out of ${questionOrders.length} questions.` 
      });
    }

    // Update each question's order
    const updatePromises = questionOrders.map(item => 
      db.collection('global_questions').updateOne(
        { _id: new ObjectId(item.id) },
        { 
          $set: { 
            order: item.order,
            updated_at: new Date()
          } 
        }
      )
    );

    const updateResults = await Promise.all(updatePromises);
    
    // Count successful updates
    const successfulUpdates = updateResults.filter(result => result.modifiedCount > 0).length;

    console.log(`📋 Questions reordered in ${phase} phase by ${req.user.email} - ${successfulUpdates}/${questionOrders.length} updated`);

    res.status(200).send({
      message: `Questions reordered successfully in ${phase} phase`,
      phase: phase,
      total_questions: questionOrders.length,
      successfully_updated: successfulUpdates,
      question_orders: questionOrders.map(item => ({
        id: item.id,
        order: item.order
      }))
    });

  } catch (error) {
    console.error('Reorder questions error:', error);
    
    if (error.message.includes('Invalid ObjectId')) {
      return res.status(400).send({ 
        message: 'Invalid question ID format',
        error: error.message 
      });
    }
    
    res.status(500).send({ 
      message: 'Server error during reorder', 
      error: error.message 
    });
  }
}); 

app.put('/api/super-admin/global-questions/:questionId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questionId } = req.params;
    const { question_text } = req.body;

    if (!question_text) {
      return res.status(400).send({ message: 'Question text is required' });
    }

    if (!ObjectId.isValid(questionId)) {
      return res.status(400).send({ message: 'Invalid question ID' });
    }

    const questionObjectId = new ObjectId(questionId);
    const question = await db.collection('global_questions').findOne({ _id: questionObjectId });

    if (!question) {
      return res.status(404).send({ message: 'Question not found' });
    }

    await db.collection('global_questions').updateOne(
      { _id: questionObjectId },
      { 
        $set: { 
          question_text: question_text.trim(),
          updated_at: new Date()
        } 
      }
    );

    res.status(200).send({
      message: 'Question updated successfully',
      question: {
        _id: questionObjectId,
        question_text: question_text.trim(),
        phase: question.phase,
        severity: question.severity
      }
    });

  } catch (error) {
    console.error('Update question error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/super-admin/global-questions/:questionId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questionId } = req.params;

    if (!ObjectId.isValid(questionId)) {
      return res.status(400).send({ message: 'Invalid question ID' });
    }

    const questionObjectId = new ObjectId(questionId);
    const question = await db.collection('global_questions').findOne({ _id: questionObjectId });

    if (!question) {
      return res.status(404).send({ message: 'Question not found' });
    }

    // Delete from all collections
    await Promise.all([
      db.collection('company_questions').deleteMany({ global_question_id: questionObjectId }),
      db.collection('user_progress').deleteMany({ question_id: questionObjectId }),
      db.collection('user_chat_history').deleteMany({ question_id: questionObjectId }),
      db.collection('global_questions').deleteOne({ _id: questionObjectId })
    ]);

    res.status(200).send({
      message: 'Question deleted successfully',
      deleted_question: {
        _id: question._id,
        question_text: question.question_text
      }
    });

  } catch (error) {
    console.error('Delete question error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
}); 
// ===============================
// SUPER ADMIN - COMPANY MANAGEMENT
// ===============================

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

// ===============================
// ADMIN - USER MANAGEMENT
// ===============================

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

    const companyIds = [...new Set(users.map(user => user.company_id).filter(Boolean))];
    const companies = await db.collection('companies')
      .find({ _id: { $in: companyIds } })
      .toArray();

    const companyLookup = companies.reduce((acc, company) => {
      acc[company._id.toString()] = company.company_name;
      return acc;
    }, {});

    const formattedUsers = users.map(user => ({
      id: user._id,
      name: user.name,
      email: user.email,
      role: roleLookup[user.role_id?.toString()] || 'unknown',
      status: user.status,
      company_id: user.company_id,
      company_name: companyLookup[user.company_id?.toString()] || null,
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
    const role = req.user.role.role_name;
    if (role !== 'super_admin' && role !== 'company_admin') {
      return res.status(403).send({ message: 'Access denied. Only super_admin or company_admin allowed.' });
    }

    const roles = await db.collection('roles').find().toArray();

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

// ===============================
// ADMIN - USER DATA ENDPOINTS
// ===============================

app.get('/api/admin/user-data/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserRole = req.user.role.role_name;
    const requestingUserCompanyId = req.user.company_id;

    if (!['super_admin', 'company_admin'].includes(requestingUserRole)) {
      return res.status(403).send({ message: 'Admin access required' });
    }

    if (!ObjectId.isValid(userId)) {
      return res.status(400).send({ message: 'Invalid user ID' });
    }

    const targetUserId = new ObjectId(userId);

    // Get target user info
    const targetUser = await db.collection('users').findOne({ _id: targetUserId });
    if (!targetUser) {
      return res.status(404).send({ message: 'User not found' });
    }

    // Company admin can only view users from their company
    if (requestingUserRole === 'company_admin') {
      if (!targetUser.company_id || targetUser.company_id.toString() !== requestingUserCompanyId.toString()) {
        return res.status(403).send({ message: 'You can only view users from your company' });
      }
    }

    // Get user progress (main answers and followups)
    const userProgress = await db.collection('user_progress').find({
      user_id: targetUserId,
      company_id: targetUser.company_id
    }).sort({ answered_at: 1 }).toArray();

    // Get chat history
    const chatHistory = await db.collection('user_chat_history').find({
      user_id: targetUserId,
      company_id: targetUser.company_id
    }).sort({ timestamp: 1 }).toArray();

    // Get question details from global_questions or company_questions
    let questionDetailsMap = {};
    
    if (requestingUserRole === 'super_admin') {
      const globalQuestions = await db.collection('global_questions').find({}).toArray();
      globalQuestions.forEach(q => {
        questionDetailsMap[q._id.toString()] = {
          question_text: q.question_text,
          phase: q.phase,
          severity: q.severity,
          order: q.order
        };
      });
    } else {
      const companyQuestions = await db.collection('company_questions').aggregate([
        { $match: { company_id: targetUser.company_id } },
        {
          $lookup: {
            from: 'global_questions',
            localField: 'global_question_id',
            foreignField: '_id',
            as: 'global_question'
          }
        },
        { $unwind: '$global_question' }
      ]).toArray();

      companyQuestions.forEach(cq => {
        const questionId = cq.global_question._id.toString();
        questionDetailsMap[questionId] = {
          question_text: cq.is_customized ? cq.custom_question_text : cq.global_question.question_text,
          phase: cq.global_question.phase,
          severity: cq.global_question.severity,
          order: cq.global_question.order
        };
      });
    }

    // Group progress by question_id
    const progressByQuestion = {};
    userProgress.forEach(progress => {
      const questionId = progress.question_id.toString();
      if (!progressByQuestion[questionId]) {
        progressByQuestion[questionId] = {
          main_answer: null,
          followups: []
        };
      }
      
      if (progress.is_followup) {
        progressByQuestion[questionId].followups.push(progress);
      } else {
        progressByQuestion[questionId].main_answer = progress;
      }
    });

    // Group chat history by question_id for followup questions
    const chatByQuestion = {};
    chatHistory.forEach(chat => {
      if (chat.question_id) {
        const questionId = chat.question_id.toString();
        if (!chatByQuestion[questionId]) {
          chatByQuestion[questionId] = [];
        }
        chatByQuestion[questionId].push(chat);
      }
    });

    // Build conversation structure grouped by phase
    const conversationByPhase = {};

    // Process each question that has answers
    Object.keys(progressByQuestion).forEach(questionId => {
      const questionDetails = questionDetailsMap[questionId];
      if (!questionDetails) return;

      const phase = questionDetails.phase;
      const severity = questionDetails.severity;

      // Initialize phase if not exists
      if (!conversationByPhase[phase]) {
        conversationByPhase[phase] = {
          phase: phase,
          severity: severity,
          questions: []
        };
      }

      const questionData = progressByQuestion[questionId];
      const relatedChats = chatByQuestion[questionId] || [];

      // Build question object
      const questionObj = {
        question: questionDetails.question_text,
        answer: questionData.main_answer ? questionData.main_answer.answer_text : null
      };

      // Add followups if they exist
      if (questionData.followups && questionData.followups.length > 0) {
        // Sort followups by answered_at
        questionData.followups.sort((a, b) => new Date(a.answered_at) - new Date(b.answered_at));

        questionData.followups.forEach((followup, index) => {
          // Find the bot message (followup question) that's closest in time to this followup answer
          const followupQuestion = relatedChats
            .filter(chat => 
              chat.message_type === 'bot' && 
              chat.metadata?.isFollowUp &&
              new Date(chat.timestamp) <= new Date(followup.answered_at)
            )
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[index]; // Get the nth followup question

          questionObj[`followup_question_${index + 1}`] = followupQuestion ? followupQuestion.message_text : `Followup question ${index + 1}`;
          questionObj[`followup_answer_${index + 1}`] = followup.answer_text;
        });
      }

      conversationByPhase[phase].questions.push(questionObj);
    });

    // Sort questions within each phase by order
    Object.values(conversationByPhase).forEach(phaseData => {
      phaseData.questions.sort((a, b) => {
        // Find the order for each question
        const aQuestionId = Object.keys(progressByQuestion).find(qId => {
          const details = questionDetailsMap[qId];
          return details && details.question_text === a.question;
        });
        const bQuestionId = Object.keys(progressByQuestion).find(qId => {
          const details = questionDetailsMap[qId];
          return details && details.question_text === b.question;
        });

        const aOrder = aQuestionId ? questionDetailsMap[aQuestionId].order : 0;
        const bOrder = bQuestionId ? questionDetailsMap[bQuestionId].order : 0;

        return aOrder - bOrder;
      });
    });

    // Convert to array and sort by phase order
    const phaseOrder = ['initial', 'essential', 'good', 'excellent'];
    const conversation = Object.values(conversationByPhase).sort((a, b) => {
      const aIndex = phaseOrder.indexOf(a.phase);
      const bIndex = phaseOrder.indexOf(b.phase);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });

    // Extract system analysis from chat history - look for message_type: 'system'
    const systemAnalysis = [];
    
    chatHistory.forEach(chat => {
      // Look for system messages that contain analysis
      if (chat.message_type === 'system') {
        const analysisName = chat.message_text; // The message_text contains the analysis name
        
        // Look for analysis data in metadata
        let analysisData = null;
        
        if (chat.metadata) {
          // Check for analysis_result in metadata
          if (chat.metadata.analysis_result) {
            analysisData = chat.metadata.analysis_result;
          }
          // Check for analysisData in metadata
          else if (chat.metadata.analysisData) {
            analysisData = chat.metadata.analysisData;
          }
          // Check for analysis in metadata
          else if (chat.metadata.analysis && chat.metadata.analysis !== true) {
            analysisData = chat.metadata.analysis;
          }
          // Check for specific analysis types (swot, competitive, etc.)
          else if (chat.metadata[analysisName]) {
            analysisData = chat.metadata[analysisName];
          }
          // Check for analysis with underscores
          else if (chat.metadata[analysisName + '_analysis']) {
            analysisData = chat.metadata[analysisName + '_analysis'];
          }
          // Look for any object in metadata that could be analysis data
          else {
            const metadataKeys = Object.keys(chat.metadata);
            for (const key of metadataKeys) {
              const value = chat.metadata[key];
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                // Check if it looks like analysis data (has multiple properties)
                const valueKeys = Object.keys(value);
                if (valueKeys.length > 1) {
                  analysisData = value;
                  break;
                }
              }
            }
          }
        }
        
        if (analysisData) {
          systemAnalysis.push({
            name: analysisName,
            analysis_result: typeof analysisData === 'string' ? 
              analysisData : JSON.stringify(analysisData)
          });
        }
      }
      
      // Also check other message types that might have analysis in metadata
      else if (chat.metadata) {
        // Check for various analysis types in metadata for non-system messages
        if (chat.metadata.analysis_type && chat.metadata.analysis_result) {
          systemAnalysis.push({
            name: chat.metadata.analysis_type,
            analysis_result: typeof chat.metadata.analysis_result === 'string' ? 
              chat.metadata.analysis_result : JSON.stringify(chat.metadata.analysis_result)
          });
        }
        
        // Check for specific analysis fields
        Object.keys(chat.metadata).forEach(key => {
          if (key.includes('analysis') && key !== 'analysis_type' && typeof chat.metadata[key] === 'object') {
            const analysisData = chat.metadata[key];
            if (analysisData && Object.keys(analysisData).length > 0) {
              systemAnalysis.push({
                name: key.replace('_analysis', '').replace('analysis_', ''),
                analysis_result: JSON.stringify(analysisData)
              });
            }
          }
        });
      }
    });

    // Remove duplicates from system analysis
    const uniqueSystemAnalysis = systemAnalysis.filter((analysis, index, self) => 
      index === self.findIndex(a => a.name === analysis.name && a.analysis_result === analysis.analysis_result)
    );

    // Return the structured response
    res.status(200).send({
      conversation: conversation,
      system: uniqueSystemAnalysis
    });

  } catch (error) {
    console.error('Get user data error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.get('/api/company-admin/users', authenticateToken, async (req, res) => {
  try {
    const requestingUserRole = req.user.role.role_name;
    const requestingUserCompanyId = req.user.company_id;
    const { company_id } = req.query;

    if (!['super_admin', 'company_admin'].includes(requestingUserRole)) {
      return res.status(403).send({ message: 'Admin access required' });
    }

    let query = {};
    let targetCompanyId = null;

    if (requestingUserRole === 'super_admin') {
      if (company_id) {
        targetCompanyId = new ObjectId(company_id);
        query.company_id = targetCompanyId;
      }
    } else if (requestingUserRole === 'company_admin') {
      targetCompanyId = requestingUserCompanyId;
      query.company_id = targetCompanyId;
    }

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

    const usersWithActivity = await Promise.all(
      users.map(async (user) => {
        const [answerCount, chatCount] = await Promise.all([
          db.collection('user_progress').countDocuments({ user_id: user._id }),
          db.collection('user_chat_history').countDocuments({ user_id: user._id })
        ]);

        return {
          ...user,
          activity_summary: {
            total_answers: answerCount,
            total_chat_messages: chatCount,
            has_activity: answerCount > 0 || chatCount > 0
          }
        };
      })
    );

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
      message: 'Clean Traxxia API with MongoDB ObjectIds is running 🚀',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      statistics: { 
        companies, 
        users, 
        global_questions: questions, 
        user_progress: progressEntries 
      },
      features: ['MongoDB ObjectIds', 'Clean Code Architecture', 'Bulk Upload', 'Progress Tracking']
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
// START SERVER
// ===============================

connectToMongoDB().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Clean Traxxia API Server running on port ${port}`); 
    console.log(`🆔 IDs: Using MongoDB ObjectIds (native)`);
    console.log(`📚 Bulk Upload: Support for multiple questions`);
    console.log(`🧹 Clean Code: Simplified and optimized`);
    console.log(`💾 Progress Tracking: Complete user journey`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});