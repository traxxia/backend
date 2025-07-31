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

    // Sessions and chat indexes
    await db.collection('user_sessions').createIndex({ user_id: 1, company_id: 1 });
    await db.collection('user_answers').createIndex({ session_id: 1, user_id: 1 });
    await db.collection('chat_conversations').createIndex({ session_id: 1, user_id: 1 });
    await db.collection('phase_results').createIndex({ session_id: 1, user_id: 1, phase_name: 1 });

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
                cond: { $eq: ['$$this.status', 'active'] }
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

// Bulk Create Global Questions
app.post('/api/super-admin/global-questions/bulk', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).send({ message: 'Questions array is required' });
    }

    // Validate all questions first
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question_id || !q.question_text || !q.phase || !q.severity) {
        return res.status(400).send({
          message: `Question at index ${i}: Question ID, text, phase, and severity are required`
        });
      }
    }

    const questionIds = questions.map(q => q.question_id);
    const duplicateIds = questionIds.filter((id, index) => questionIds.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      return res.status(400).send({
        message: `Duplicate question IDs found: ${duplicateIds.join(', ')}`
      });
    }

    const existingQuestions = await db.collection('global_questions').find({
      question_id: { $in: questionIds }
    }).toArray();

    if (existingQuestions.length > 0) {
      const existingIds = existingQuestions.map(q => q.question_id);
      return res.status(400).send({
        message: `Question IDs already exist: ${existingIds.join(', ')}`
      });
    }

    const newQuestions = questions.map(q => ({
      question_id: q.question_id,
      question_text: q.question_text,
      phase: q.phase,
      severity: q.severity,
      order: q.order || 999,
      is_active: true,
      created_at: new Date()
    }));

    const result = await db.collection('global_questions').insertMany(newQuestions);
    const insertedQuestions = Object.values(result.insertedIds);

    // Auto-assign to all active companies
    const activeCompanies = await db.collection('companies').find({ status: 'active' }).toArray();
    const allCompanyAssignments = [];
    insertedQuestions.forEach(questionId => {
      activeCompanies.forEach(company => {
        allCompanyAssignments.push({
          company_id: company._id,
          global_question_id: questionId,
          custom_question_text: null,
          is_customized: false,
          is_active: true,
          assigned_at: new Date(),
          assigned_by: new ObjectId(req.user._id)
        });
      });
    });

    if (allCompanyAssignments.length > 0) {
      await db.collection('company_questions').insertMany(allCompanyAssignments);
    }

    res.status(201).send({
      message: `${questions.length} global questions created and assigned to all companies`,
      questions_created: questions.length,
      assigned_to_companies: activeCompanies.length,
      total_assignments: allCompanyAssignments.length
    });
  } catch (error) {
    console.error('Bulk create global questions error:', error);
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

// Update Global Question
app.put('/api/super-admin/global-questions/:questionId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questionId = req.params.questionId;
    const updates = { ...req.body };

    delete updates._id;
    delete updates.created_at;
    updates.updated_at = new Date();

    const result = await db.collection('global_questions').updateOne(
      { _id: new ObjectId(questionId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: 'Question not found' });
    }

    res.status(200).send({ message: 'Global question updated successfully' });
  } catch (error) {
    console.error('Update global question error:', error);
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

// List Company Users
app.get('/api/company-admin/users', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    let filter = {};

    if (req.user.role.role_name === 'company_admin') {
      filter.company_id = req.user.company_id;
    } else if (req.query.company_id) {
      filter.company_id = new ObjectId(req.query.company_id);
    }

    const users = await db.collection('users').aggregate([
      { $match: filter },
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
          password: 0,
          'role.permissions': 0
        }
      }
    ]).toArray();

    res.status(200).send({
      users,
      total: users.length
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// COMPANY ADMIN - QUESTION CUSTOMIZATION
// ===============================

// Get Company Questions
app.get('/api/company-admin/questions', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    const companyId = req.user.role.role_name === 'company_admin'
      ? req.user.company_id
      : new ObjectId(req.query.company_id);

    if (!companyId) {
      return res.status(400).send({ message: 'Company ID required' });
    }

    const companyQuestions = await db.collection('company_questions').aggregate([
      { $match: { company_id: companyId } },
      {
        $lookup: {
          from: 'global_questions',
          localField: 'global_question_id',
          foreignField: '_id',
          as: 'global_question'
        }
      },
      {
        $unwind: '$global_question'
      },
      {
        $project: {
          global_question_id: 1,
          custom_question_text: 1,
          is_customized: 1,
          is_active: 1,
          assigned_at: 1,
          question_id: '$global_question.question_id',
          original_question_text: '$global_question.question_text',
          phase: '$global_question.phase',
          severity: '$global_question.severity',
          order: '$global_question.order',
          final_question_text: {
            $cond: {
              if: '$is_customized',
              then: '$custom_question_text',
              else: '$global_question.question_text'
            }
          }
        }
      },
      {
        $sort: { 'order': 1, 'question_id': 1 }
      }
    ]).toArray();

    res.status(200).send({
      questions: companyQuestions,
      total: companyQuestions.length,
      company_id: companyId
    });
  } catch (error) {
    console.error('Get company questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Customize Company Question
app.put('/api/company-admin/questions/:companyQuestionId', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    const companyQuestionId = req.params.companyQuestionId;
    const { custom_question_text, is_active } = req.body;

    if (!custom_question_text && is_active === undefined) {
      return res.status(400).send({ message: 'Either custom question text or status update required' });
    }

    const updates = {};

    if (custom_question_text) {
      updates.custom_question_text = custom_question_text;
      updates.is_customized = true;
    }

    if (is_active !== undefined) {
      updates.is_active = is_active;
    }

    updates.updated_at = new Date();

    let filter = { _id: new ObjectId(companyQuestionId) };
    if (req.user.role.role_name === 'company_admin') {
      filter.company_id = req.user.company_id;
    }

    const result = await db.collection('company_questions').updateOne(filter, { $set: updates });

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: 'Question not found or access denied' });
    }

    res.status(200).send({ message: 'Question updated successfully' });
  } catch (error) {
    console.error('Customize question error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// USER - SESSION & QUESTIONS
// ===============================

// Start User Session
app.post('/api/user/start-session', authenticateToken, async (req, res) => {
  try {
    if (!canViewQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to start sessions' });
    }

    // Check if user has an active session
    const existingSession = await db.collection('user_sessions').findOne({
      user_id: new ObjectId(req.user._id),
      status: 'active'
    });

    if (existingSession) {
      return res.status(200).send({
        message: 'Active session found',
        session: existingSession,
        user_permissions: {
          can_view: canViewQuestions(req.user.role),
          can_answer: canAnswerQuestions(req.user.role),
          can_admin: req.user.role.can_admin || req.user.role.role_name === 'super_admin',
          role: req.user.role.role_name
        }
      });
    }

    let sessionCompanyId = null;
    if (req.user.role.role_name === 'super_admin') {
      sessionCompanyId = req.body.company_id ? new ObjectId(req.body.company_id) : null;
    } else {
      sessionCompanyId = req.user.company_id;
    }

    const newSession = {
      user_id: new ObjectId(req.user._id),
      company_id: sessionCompanyId,
      session_id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'active',
      current_phase: 'initial',
      current_question_index: 0,
      started_at: new Date(),
      completed_at: null,
      user_role: req.user.role.role_name
    };

    const result = await db.collection('user_sessions').insertOne(newSession);

    res.status(201).send({
      message: 'Session started successfully',
      session: { ...newSession, _id: result.insertedId },
      user_permissions: {
        can_view: canViewQuestions(req.user.role),
        can_answer: canAnswerQuestions(req.user.role),
        can_admin: req.user.role.can_admin || req.user.role.role_name === 'super_admin',
        role: req.user.role.role_name
      }
    });
  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get User's Assigned Questions
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

// ===============================
// CHAT CONVERSATION MANAGEMENT
// ===============================

// Save Chat Message
app.post('/api/chat/save-message', authenticateToken, async (req, res) => {
  try {
    const { session_id, message_type, message_text, question_id, phase, metadata = {} } = req.body;

    if (!session_id || !message_type || !message_text) {
      return res.status(400).send({ message: 'Session ID, message type, and message text are required' });
    }

    // Find session
    const session = await db.collection('user_sessions').findOne({
      session_id: session_id,
      user_id: new ObjectId(req.user._id),
      status: 'active'
    });

    if (!session) {
      return res.status(404).send({ message: 'Active session not found' });
    }

    const chatMessage = {
      session_id: session._id,
      user_id: new ObjectId(req.user._id),
      message_type, // 'user', 'bot', 'system'
      message_text,
      question_id: question_id || null,
      phase: phase || null,
      metadata,
      timestamp: new Date(),
      is_followup: metadata.isFollowUp || false,
      is_phase_validation: metadata.isPhaseValidation || false
    };

    const result = await db.collection('chat_conversations').insertOne(chatMessage);

    res.status(201).send({
      message: 'Chat message saved successfully',
      chat_message: { ...chatMessage, _id: result.insertedId }
    });
  } catch (error) {
    console.error('Save chat message error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get Chat History
app.get('/api/chat/history/:sessionId', authenticateToken, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    // Find session
    const session = await db.collection('user_sessions').findOne({
      session_id: sessionId,
      user_id: new ObjectId(req.user._id)
    });

    if (!session) {
      return res.status(404).send({ message: 'Session not found' });
    }

    const chatHistory = await db.collection('chat_conversations')
      .find({ session_id: session._id })
      .sort({ timestamp: 1 })
      .toArray();

    res.status(200).send({
      session_info: {
        session_id: session.session_id,
        current_phase: session.current_phase,
        status: session.status
      },
      chat_history: chatHistory,
      total_messages: chatHistory.length
    });
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// ANSWER SUBMISSION & VALIDATION
// ===============================

// Submit Answer
app.post('/api/user/submit-answer', authenticateToken, async (req, res) => {
  try {
    if (!canAnswerQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to submit answers' });
    }

    const { session_id, question_id, answer_text } = req.body;

    if (!session_id || !question_id || !answer_text) {
      return res.status(400).send({ message: 'Session ID, question ID, and answer text are required' });
    }

    // Find session
    let sessionFilter = { status: 'active' };

    if (req.user.role.role_name === 'super_admin') {
      sessionFilter.session_id = session_id;
    } else if (req.user.role.role_name === 'company_admin') {
      sessionFilter = {
        session_id: session_id,
        company_id: req.user.company_id,
        status: 'active'
      };
    } else {
      sessionFilter = {
        session_id: session_id,
        user_id: new ObjectId(req.user._id),
        status: 'active'
      };
    }

    const session = await db.collection('user_sessions').findOne(sessionFilter);

    if (!session) {
      return res.status(404).send({ message: 'Active session not found or access denied' });
    }

    // Find the question
    let companyQuestion = [];

    if (req.user.role.role_name === 'super_admin' && !session.company_id) {
      const globalQuestion = await db.collection('global_questions').findOne({
        question_id: parseInt(question_id),
        is_active: true
      });

      if (!globalQuestion) {
        return res.status(404).send({ message: 'Global question not found' });
      }

      companyQuestion = [{
        _id: globalQuestion._id,
        global_question_id: globalQuestion._id,
        is_customized: false,
        custom_question_text: null,
        global_question: globalQuestion
      }];
    } else {
      const targetCompanyId = session.company_id;

      if (!targetCompanyId) {
        return res.status(400).send({ message: 'No company assigned to session' });
      }

      companyQuestion = await db.collection('company_questions').aggregate([
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
        { $match: { 'global_question.question_id': parseInt(question_id) } }
      ]).toArray();
    }

    if (companyQuestion.length === 0) {
      return res.status(404).send({ message: 'Question not found' });
    }

    const question = companyQuestion[0];

    // Check if answer already exists
    const existingAnswer = await db.collection('user_answers').findOne({
      session_id: session._id,
      question_id: parseInt(question_id)
    });

    if (existingAnswer) {
      // Update existing answer
      await db.collection('user_answers').updateOne(
        { _id: existingAnswer._id },
        {
          $set: {
            answer_text: answer_text.trim(),
            answered_at: new Date(),
            attempt_count: (existingAnswer.attempt_count || 1) + 1,
            answered_by: new ObjectId(req.user._id)
          }
        }
      );
    } else {
      // Create new answer
      const newAnswer = {
        session_id: session._id,
        user_id: session.user_id,
        answered_by: new ObjectId(req.user._id),
        question_id: parseInt(question_id),
        question_text: question.is_customized ? question.custom_question_text : question.global_question.question_text,
        answer_text: answer_text.trim(),
        phase: question.global_question.phase,
        attempt_count: 1,
        answered_at: new Date(),
        confidence_score: 0.8
      };

      await db.collection('user_answers').insertOne(newAnswer);
    }

    // Update session last activity
    await db.collection('user_sessions').updateOne(
      { _id: session._id },
      { $set: { last_activity: new Date() } }
    );

    res.status(200).send({
      message: 'Answer submitted successfully',
      question_id: parseInt(question_id),
      phase: question.global_question.phase,
      submitted_by: req.user.role.role_name
    });
  } catch (error) {
    console.error('Submit answer error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Complete Phase and Generate Results
app.post('/api/user/complete-phase', authenticateToken, async (req, res) => {
  try {
    if (!canAnswerQuestions(req.user.role)) {
      return res.status(403).send({ message: 'You do not have permission to complete phases' });
    }

    const { session_id, phase_name } = req.body;

    if (!session_id || !phase_name) {
      return res.status(400).send({ message: 'Session ID and phase name are required' });
    }

    // Find session
    let sessionFilter = { status: 'active' };

    if (req.user.role.role_name === 'super_admin') {
      sessionFilter.session_id = session_id;
    } else if (req.user.role.role_name === 'company_admin') {
      sessionFilter = {
        session_id: session_id,
        company_id: req.user.company_id,
        status: 'active'
      };
    } else {
      sessionFilter = {
        session_id: session_id,
        user_id: new ObjectId(req.user._id),
        status: 'active'
      };
    }

    const session = await db.collection('user_sessions').findOne(sessionFilter);

    if (!session) {
      return res.status(404).send({ message: 'Active session not found or access denied' });
    }

    // Get all answers for this phase
    const phaseAnswers = await db.collection('user_answers').aggregate([
      { $match: { session_id: session._id, phase: phase_name } },
      {
        $lookup: {
          from: 'global_questions',
          localField: 'question_id',
          foreignField: 'question_id',
          as: 'question_info'
        }
      },
      { $unwind: { path: '$question_info', preserveNullAndEmptyArrays: true } }
    ]).toArray();

    if (phaseAnswers.length === 0) {
      return res.status(400).send({ message: 'No answers found for this phase' });
    }

    // Generate phase results
    const resultData = {
      phase: phase_name,
      total_questions: phaseAnswers.length,
      answers_summary: phaseAnswers.map(answer => ({
        question_id: answer.question_id,
        question: answer.question_text,
        answer: answer.answer_text.substring(0, 100) + '...',
        confidence: answer.confidence_score
      })),
      completion_percentage: 100,
      insights: `Phase ${phase_name} completed with ${phaseAnswers.length} questions answered.`,
      completed_by: req.user.role.role_name
    };

    // Save phase results
    const phaseResult = {
      session_id: session._id,
      user_id: session.user_id,
      completed_by: new ObjectId(req.user._id),
      phase_name,
      result_type: 'phase_completion',
      result_data: resultData,
      analysis_output: {
        summary: `User completed ${phase_name} phase successfully`,
        recommendations: ['Continue to next phase', 'Review answers if needed']
      },
      generated_at: new Date(),
      quality_score: 85,
      status: 'completed'
    };

    await db.collection('phase_results').insertOne(phaseResult);

    // Update session current phase
    await db.collection('user_sessions').updateOne(
      { _id: session._id },
      {
        $set: {
          current_phase: phase_name,
          last_activity: new Date()
        }
      }
    );

    res.status(200).send({
      message: `Phase ${phase_name} completed successfully`,
      results: resultData,
      next_phase: getNextPhase(phase_name),
      completed_by: req.user.role.role_name
    });
  } catch (error) {
    console.error('Complete phase error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Helper function to determine next phase
function getNextPhase(currentPhase) {
  const phaseOrder = ['initial', 'essential', 'good', 'excellent'];
  const currentIndex = phaseOrder.indexOf(currentPhase);
  return currentIndex < phaseOrder.length - 1 ? phaseOrder[currentIndex + 1] : 'completed';
}

// ===============================
// ADMIN REPORTING & MONITORING
// ===============================

// Get User Sessions (Admin view)
app.get('/api/admin/sessions', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    const companyId = req.user.role.role_name === 'company_admin'
      ? req.user.company_id
      : req.query.company_id ? new ObjectId(req.query.company_id) : null;

    let filter = {};
    if (companyId) {
      filter.company_id = companyId;
    }

    const sessions = await db.collection('user_sessions').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'companies',
          localField: 'company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          session_id: 1,
          status: 1,
          current_phase: 1,
          started_at: 1,
          completed_at: 1,
          last_activity: 1,
          user_role: 1,
          user_name: '$user.name',
          user_email: '$user.email',
          company_name: '$company.company_name'
        }
      },
      { $sort: { started_at: -1 } }
    ]).toArray();

    res.status(200).send({
      sessions,
      total: sessions.length
    });
  } catch (error) {
    console.error('Get admin sessions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get User Data (Admin view)
app.get('/api/admin/user-data/:userId', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    const userId = req.params.userId;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).send({ message: 'Invalid user ID' });
    }

    // For company admin, ensure user belongs to their company
    let userFilter = { _id: new ObjectId(userId) };
    if (req.user.role.role_name === 'company_admin') {
      userFilter.company_id = req.user.company_id;
    }

    const user = await db.collection('users').findOne(userFilter);
    if (!user) {
      return res.status(404).send({ message: 'User not found or access denied' });
    }

    // Get user sessions
    const sessions = await db.collection('user_sessions').find({
      user_id: new ObjectId(userId)
    }).sort({ started_at: -1 }).toArray();

    // Get user answers for latest session
    let userAnswers = [];
    let phaseResults = [];
    let chatHistory = [];

    if (sessions.length > 0) {
      const latestSession = sessions[0];

      userAnswers = await db.collection('user_answers').find({
        session_id: latestSession._id
      }).sort({ answered_at: 1 }).toArray();

      phaseResults = await db.collection('phase_results').find({
        session_id: latestSession._id
      }).sort({ generated_at: -1 }).toArray();

      chatHistory = await db.collection('chat_conversations').find({
        session_id: latestSession._id
      }).sort({ timestamp: 1 }).toArray();
    }

    res.status(200).send({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        created_at: user.created_at,
        last_login: user.last_login
      },
      sessions,
      answers: userAnswers,
      phase_results: phaseResults,
      chat_history: chatHistory,
      summary: {
        total_sessions: sessions.length,
        total_answers: userAnswers.length,
        completed_phases: phaseResults.length,
        latest_activity: sessions.length > 0 ? sessions[0].last_activity : null
      }
    });
  } catch (error) {
    console.error('Get user data error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get Company Summary (for Company Admin)
app.get('/api/admin/company-summary', authenticateToken, requireCompanyAdmin, async (req, res) => {
  try {
    const companyId = req.user.role.role_name === 'company_admin'
      ? req.user.company_id
      : new ObjectId(req.query.company_id);

    if (!companyId) {
      return res.status(400).send({ message: 'Company ID required' });
    }

    const [
      company,
      totalUsers,
      activeUsers,
      totalSessions,
      activeSessions,
      totalAnswers,
      totalPhaseResults,
      recentActivity
    ] = await Promise.all([
      db.collection('companies').findOne({ _id: companyId }),
      db.collection('users').countDocuments({ company_id: companyId }),
      db.collection('users').countDocuments({ company_id: companyId, status: 'active' }),
      db.collection('user_sessions').countDocuments({ company_id: companyId }),
      db.collection('user_sessions').countDocuments({ company_id: companyId, status: 'active' }),
      db.collection('user_answers').countDocuments({
        user_id: { $in: await db.collection('users').distinct('_id', { company_id: companyId }) }
      }),
      db.collection('phase_results').countDocuments({
        user_id: { $in: await db.collection('users').distinct('_id', { company_id: companyId }) }
      }),
      db.collection('users').find({ company_id: companyId })
        .sort({ last_login: -1 })
        .limit(5)
        .project({ name: 1, email: 1, last_login: 1 })
        .toArray()
    ]);

    res.status(200).send({
      company: {
        id: company._id,
        name: company.company_name,
        industry: company.industry,
        size: company.size
      },
      statistics: {
        users: { total: totalUsers, active: activeUsers },
        sessions: { total: totalSessions, active: activeSessions },
        engagement: {
          total_answers: totalAnswers,
          phase_results: totalPhaseResults,
          avg_answers_per_user: totalUsers > 0 ? Math.round(totalAnswers / totalUsers) : 0
        }
      },
      recent_activity: recentActivity
    });
  } catch (error) {
    console.error('Get company summary error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// SUPER ADMIN - SYSTEM OVERVIEW
// ===============================

// Get System Overview
app.get('/api/super-admin/system-overview', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const [
      totalCompanies,
      activeCompanies,
      totalUsers,
      activeUsers,
      totalGlobalQuestions,
      totalSessions,
      totalAnswers,
      totalPhaseResults,
      companyBreakdown
    ] = await Promise.all([
      db.collection('companies').countDocuments({}),
      db.collection('companies').countDocuments({ status: 'active' }),
      db.collection('users').countDocuments({}),
      db.collection('users').countDocuments({ status: 'active' }),
      db.collection('global_questions').countDocuments({ is_active: true }),
      db.collection('user_sessions').countDocuments({}),
      db.collection('user_answers').countDocuments({}),
      db.collection('phase_results').countDocuments({}),
      db.collection('companies').aggregate([
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
            status: 1,
            user_count: { $size: '$users' },
            active_user_count: {
              $size: {
                $filter: {
                  input: '$users',
                  cond: { $eq: ['$this.status', 'active'] }
                }
              }
            }
          }
        }
      ]).toArray()
    ]);

    res.status(200).send({
      system_statistics: {
        companies: { total: totalCompanies, active: activeCompanies },
        users: { total: totalUsers, active: activeUsers },
        content: { global_questions: totalGlobalQuestions },
        engagement: {
          total_sessions: totalSessions,
          total_answers: totalAnswers,
          phase_results: totalPhaseResults,
          avg_answers_per_user: totalUsers > 0 ? Math.round(totalAnswers / totalUsers) : 0
        }
      },
      company_breakdown: companyBreakdown,
      generated_at: new Date()
    });
  } catch (error) {
    console.error('Get system overview error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// HEALTH CHECK
// ===============================

app.get('/health', async (req, res) => {
  try {
    const dbStatus = db ? 'Connected' : 'Disconnected';

    const [companies, users, questions, sessions] = await Promise.all([
      db ? db.collection('companies').estimatedDocumentCount() : 0,
      db ? db.collection('users').estimatedDocumentCount() : 0,
      db ? db.collection('global_questions').estimatedDocumentCount() : 0,
      db ? db.collection('user_sessions').estimatedDocumentCount() : 0
    ]);

    res.status(200).send({
      message: 'Multi-Tenant Traxxia API is running 🚀',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      statistics: { companies, users, global_questions: questions, sessions },
      architecture: 'Multi-tenant with company isolation',
      roles: ['super_admin', 'company_admin', 'viewer_user', 'answerer_user']
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
    console.log(`🚀 Multi-Tenant Traxxia API Server running on port ${port}`);
    console.log(`🏢 Architecture: Company-based multi-tenancy`);
    console.log(`👑 Super Admin Setup: Available`);
    console.log(`🔧 Company Management: Enabled`);
    console.log(`📋 Question System: Global + Company Customization`);
    console.log(`💬 Chat System: Conversation history enabled`);
    console.log(`👥 User Management: Role-based access control`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});