const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5001;
const secretKey = process.env.SECRET_KEY || 'default_secret_key';
const multer = require('multer');
const path = require('path');
const fs = require('fs');


app.use(bodyParser.json());
app.use(cors());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_simple';
let db;
const uploadsDir = path.join(__dirname, 'uploads', 'logos');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
// ===============================
// DATABASE CONNECTION & SETUP
// ===============================

async function connectToMongoDB() {
  try {
    console.log('=== MONGODB DEBUG INFO ===');
    console.log('Raw MONGO_URI from env:', process.env.MONGO_URI ? 'SET' : 'NOT SET');
    console.log('Using MONGO_URI:', MONGO_URI.replace(/\/\/.*:.*@/, '//***:***@'));
    
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();
    
    // Log the actual database name being used
    console.log('Connected to database:', db.databaseName);
    console.log('=== END DEBUG INFO ===');
    
    await initializeSystem();
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  }
}

async function initializeSystem() {
  try {
    // Create default roles
    const existingRoles = await db.collection('roles').countDocuments();
    if (existingRoles === 0) {
      await db.collection('roles').insertMany([
        {
          role_name: 'super_admin',
          permissions: ['manage_all'],
          can_view: true,
          can_answer: true,
          created_at: new Date()
        },
        {
          role_name: 'company_admin',
          permissions: ['manage_company'],
          can_view: true,
          can_answer: true,
          created_at: new Date()
        },
        {
          role_name: 'user',
          permissions: ['answer_questions'],
          can_view: true,
          can_answer: true,
          created_at: new Date()
        }
      ]);
    }

    // Create super admin user
    const superAdminRole = await db.collection('roles').findOne({ role_name: 'super_admin' });
    const existingSuperAdmin = await db.collection('users').findOne({ role_id: superAdminRole._id });

    if (!existingSuperAdmin) {
      const hashedPassword = await bcrypt.hash('admin123', 12);
      await db.collection('users').insertOne({
        name: 'Super Admin',
        email: 'admin@traxxia.com',
        password: hashedPassword,
        role_id: superAdminRole._id,
        company_id: null,
        created_at: new Date()
      });
    }
  } catch (error) {
    console.error('System initialization failed:', error);
  }
}

// ===============================
// MIDDLEWARE
// ===============================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, secretKey, async (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });

    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.id) });
    if (!user) return res.status(403).json({ error: 'User not found' });

    const role = await db.collection('roles').findOne({ _id: user.role_id });
    req.user = { ...user, role };
    next();
  });
};

const requireAdmin = (req, res, next) => {
  const role = req.user.role.role_name;
  if (!['super_admin', 'company_admin'].includes(role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user.role.role_name !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'company_logo_' + uniqueSuffix + ext);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'), false);
    }
  }
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===============================
// AUTHENTICATION APIs
// ===============================

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await db.collection('users').findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const role = await db.collection('roles').findOne({ _id: user.role_id });

    // Get company details including logo
    let company = null;
    if (user.company_id) {
      company = await db.collection('companies').findOne(
        { _id: user.company_id },
        { projection: { company_name: 1, logo: 1, industry: 1 } }
      );
    }

    const token = jwt.sign({
      id: user._id,
      email: user.email,
      role: role.role_name
    }, secretKey, { expiresIn: '24h' });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: role.role_name,
        company: company ? {
          name: company.company_name,
          logo: company.logo,
          industry: company.industry
        } : null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, company_id, terms_accepted } = req.body;

    if (!name || !email || !password || !company_id || !terms_accepted) {
      return res.status(400).json({ error: 'All fields required including terms acceptance' });
    }

    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const company = await db.collection('companies').findOne({
      _id: new ObjectId(company_id),
      status: 'active'
    });
    if (!company) {
      return res.status(400).json({ error: 'Invalid company' });
    }

    const userRole = await db.collection('roles').findOne({ role_name: 'user' });
    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await db.collection('users').insertOne({
      name,
      email,
      password: hashedPassword,
      role_id: userRole._id,
      company_id: new ObjectId(company_id),
      terms_accepted,
      created_at: new Date()
    });

    res.json({
      message: 'Registration successful',
      user_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ===============================
// COMPANIES API
// ===============================

app.get('/api/companies', async (req, res) => {
  try {
    const companies = await db.collection('companies')
      .find({ status: 'active' })
      .project({ company_name: 1, industry: 1, logo: 1 })
      .sort({ company_name: 1 })
      .toArray();

    res.json({ companies });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// ===============================
// BUSINESSES API
// ===============================

app.get('/api/businesses', authenticateToken, async (req, res) => {
  try {
    const businesses = await db.collection('user_businesses')
      .find({ user_id: new ObjectId(req.user._id) })
      .sort({ created_at: -1 })
      .toArray();

    // Get total active questions count
    const totalQuestions = await db.collection('global_questions')
      .countDocuments({ is_active: true });

    // Enhanced businesses with question statistics
    const enhancedBusinesses = await Promise.all(
      businesses.map(async (business) => {
        // Get all conversations for this business
        const conversations = await db.collection('user_business_conversations')
          .find({
            user_id: new ObjectId(req.user._id),
            business_id: business._id,
            conversation_type: 'question_answer'
          })
          .toArray();

        // Group conversations by question_id to find completion status
        const questionStats = {};

        conversations.forEach(conv => {
          if (conv.question_id) {
            const questionId = conv.question_id.toString();

            // Initialize question stats if not exists
            if (!questionStats[questionId]) {
              questionStats[questionId] = {
                hasAnswers: false,
                isComplete: false,
                answerCount: 0
              };
            }

            // Check if there are actual answers
            if (conv.answer_text && conv.answer_text.trim() !== '') {
              questionStats[questionId].hasAnswers = true;
              questionStats[questionId].answerCount++;
            }

            // Check completion status from metadata
            if (conv.metadata && conv.metadata.is_complete === true) {
              questionStats[questionId].isComplete = true;
            }
          }
        });

        // Count completed and pending questions
        const completedQuestions = Object.values(questionStats).filter(
          stat => stat.isComplete || stat.hasAnswers
        ).length;

        const pendingQuestions = totalQuestions - completedQuestions;

        // Calculate progress percentage
        const progressPercentage = totalQuestions > 0
          ? Math.round((completedQuestions / totalQuestions) * 100)
          : 0;

        return {
          ...business,
          question_statistics: {
            total_questions: totalQuestions,
            completed_questions: completedQuestions,
            pending_questions: pendingQuestions,
            progress_percentage: progressPercentage,
            total_answers_given: Object.values(questionStats).reduce(
              (sum, stat) => sum + stat.answerCount, 0
            )
          }
        };
      })
    );

    res.json({
      businesses: enhancedBusinesses,
      overall_stats: {
        total_businesses: businesses.length,
        total_questions_in_system: totalQuestions
      }
    });
  } catch (error) {
    console.error('Failed to fetch businesses:', error);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

app.post('/api/businesses', authenticateToken, async (req, res) => {
  try {
    const { business_name, business_purpose, description } = req.body;

    if (!business_name || !business_purpose) {
      return res.status(400).json({ error: 'Business name and purpose required' });
    }

    const existingCount = await db.collection('user_businesses')
      .countDocuments({ user_id: new ObjectId(req.user._id) });

    if (existingCount >= 5) {
      return res.status(400).json({ error: 'Maximum 5 businesses allowed' });
    }

    const result = await db.collection('user_businesses').insertOne({
      user_id: new ObjectId(req.user._id),
      business_name,
      business_purpose,
      description: description || '',
      created_at: new Date()
    });

    res.json({
      message: 'Business created',
      business_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create business' });
  }
});

// Simple DELETE business API - replaces your existing one
app.delete('/api/businesses/:id', authenticateToken, async (req, res) => {
  try {
    const businessId = new ObjectId(req.params.id);
    const userId = new ObjectId(req.user._id);

    // Delete the business
    const deleteResult = await db.collection('user_businesses').deleteOne({
      _id: businessId,
      user_id: userId
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Delete all related conversations
    await db.collection('user_business_conversations').deleteMany({
      user_id: userId,
      business_id: businessId
    });

    res.json({ message: 'Business and conversations deleted successfully' });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

// ===============================
// QUESTIONS API
// ===============================

app.get('/api/questions', authenticateToken, async (req, res) => {
  try {
    const questions = await db.collection('global_questions')
      .find({ is_active: true })
      .sort({ order: 1 })  // <-- Changed to sort only by 'order' ascending
      .toArray();

    res.json({ questions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});
// ===============================
// QUESTION MANAGEMENT APIs (Add these to your existing code)
// ===============================

// 1. Reorder Questions API
app.put('/api/admin/questions/reorder', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questions, phase } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions array is required' });
    }

    if (!phase) {
      return res.status(400).json({ error: 'Phase is required for reordering' });
    }

    // Validate that all questions have required fields
    const validationErrors = [];
    questions.forEach((question, index) => {
      if (!question.question_id || !question.order) {
        validationErrors.push({
          index: index,
          error: 'question_id and order are required for each question'
        });
      }
      if (!Number.isInteger(question.order) || question.order < 1) {
        validationErrors.push({
          index: index,
          error: 'order must be a positive integer'
        });
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        validation_errors: validationErrors
      });
    }

    // Verify all questions exist and belong to the specified phase
    const questionIds = questions.map(q => new ObjectId(q.question_id));
    const existingQuestions = await db.collection('global_questions')
      .find({
        _id: { $in: questionIds },
        phase: phase
      })
      .toArray();

    if (existingQuestions.length !== questions.length) {
      return res.status(400).json({
        error: 'One or more questions not found or do not belong to the specified phase'
      });
    }

    // Get the maximum order from other phases to maintain global ordering
    const otherPhasesMaxOrder = await db.collection('global_questions')
      .find({
        phase: { $ne: phase },
        is_active: true
      })
      .sort({ order: -1 })
      .limit(1)
      .toArray();

    // Get the minimum order from other phases that come after this phase
    const phaseOrder = ['initial', 'essential', 'good', 'excellent'];
    const currentPhaseIndex = phaseOrder.indexOf(phase);
    const laterPhases = phaseOrder.slice(currentPhaseIndex + 1);

    let nextPhaseMinOrder = null;
    if (laterPhases.length > 0) {
      const nextPhaseQuestions = await db.collection('global_questions')
        .find({
          phase: { $in: laterPhases },
          is_active: true
        })
        .sort({ order: 1 })
        .limit(1)
        .toArray();

      if (nextPhaseQuestions.length > 0) {
        nextPhaseMinOrder = nextPhaseQuestions[0].order;
      }
    }

    // Calculate the starting order for this phase
    const earlierPhases = phaseOrder.slice(0, currentPhaseIndex);
    let phaseStartOrder = 1;

    if (earlierPhases.length > 0) {
      const earlierPhasesMaxOrder = await db.collection('global_questions')
        .find({
          phase: { $in: earlierPhases },
          is_active: true
        })
        .sort({ order: -1 })
        .limit(1)
        .toArray();

      if (earlierPhasesMaxOrder.length > 0) {
        phaseStartOrder = earlierPhasesMaxOrder[0].order + 1;
      }
    }

    // Calculate new global orders for the reordered questions
    const bulkOps = questions.map((question, index) => {
      const newGlobalOrder = phaseStartOrder + index;

      return {
        updateOne: {
          filter: { _id: new ObjectId(question.question_id) },
          update: {
            $set: {
              order: newGlobalOrder,
              updated_at: new Date()
            }
          }
        }
      };
    });

    // If there are later phases, we need to shift their orders if necessary
    if (nextPhaseMinOrder !== null) {
      const maxNewOrder = phaseStartOrder + questions.length - 1;
      if (maxNewOrder >= nextPhaseMinOrder) {
        // We need to shift later phase questions
        const shiftAmount = maxNewOrder - nextPhaseMinOrder + 1;

        await db.collection('global_questions').updateMany(
          {
            phase: { $in: laterPhases },
            is_active: true
          },
          {
            $inc: { order: shiftAmount },
            $set: { updated_at: new Date() }
          }
        );
      }
    }

    // Execute the reorder operations
    const result = await db.collection('global_questions').bulkWrite(bulkOps);

    // Get the updated questions to return
    const updatedQuestions = await db.collection('global_questions')
      .find({ phase: phase, is_active: true })
      .sort({ order: 1 })
      .toArray();

    res.json({
      message: 'Questions reordered successfully',
      modified_count: result.modifiedCount,
      matched_count: result.matchedCount,
      phase: phase,
      updated_questions: updatedQuestions.map(q => ({
        question_id: q._id,
        question_text: q.question_text,
        phase: q.phase,
        order: q.order
      }))
    });

  } catch (error) {
    console.error('Failed to reorder questions:', error);
    res.status(500).json({ error: 'Failed to reorder questions' });
  }
});

// 2. Delete Question API
app.delete('/api/admin/questions/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;

    if (!ObjectId.isValid(questionId)) {
      return res.status(400).json({ error: 'Invalid question ID' });
    }

    // Check if question exists
    const question = await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    // Check if question has associated conversations
    const conversationCount = await db.collection('user_business_conversations')
      .countDocuments({ question_id: new ObjectId(questionId) });

    if (conversationCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete question with existing conversations',
        conversation_count: conversationCount
      });
    }

    // Delete the question
    const result = await db.collection('global_questions')
      .deleteOne({ _id: new ObjectId(questionId) });

    if (result.deletedCount === 0) {
      return res.status(500).json({ error: 'Failed to delete question' });
    }

    res.json({
      message: 'Question deleted successfully',
      deleted_question: {
        id: questionId,
        question_text: question.question_text,
        phase: question.phase
      }
    });

  } catch (error) {
    console.error('Failed to delete question:', error);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// 3. Edit Question API
app.put('/api/admin/questions/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;
    const { question_text, phase, severity, order, is_active } = req.body;

    if (!ObjectId.isValid(questionId)) {
      return res.status(400).json({ error: 'Invalid question ID' });
    }

    // Validate required fields
    if (!question_text || !phase || !severity) {
      return res.status(400).json({ error: 'Question text, phase, and severity are required' });
    }

    // Validate severity
    const validSeverities = ['mandatory', 'optional'];
    if (!validSeverities.includes(severity.toLowerCase())) {
      return res.status(400).json({
        error: `Severity must be one of: ${validSeverities.join(', ')}`
      });
    }

    // Validate order if provided
    if (order !== undefined && (!Number.isInteger(order) || order < 1)) {
      return res.status(400).json({ error: 'Order must be a positive integer' });
    }

    // Check if question exists
    const existingQuestion = await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });

    if (!existingQuestion) {
      return res.status(404).json({ error: 'Question not found' });
    }

    // Prepare update data
    const updateData = {
      question_text: question_text.trim(),
      phase: phase.trim(),
      severity: severity.toLowerCase(),
      updated_at: new Date()
    };

    if (order !== undefined) {
      updateData.order = order;
    }

    if (is_active !== undefined) {
      updateData.is_active = Boolean(is_active);
    }

    // Update the question
    const result = await db.collection('global_questions').updateOne(
      { _id: new ObjectId(questionId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    if (result.modifiedCount === 0) {
      return res.status(200).json({
        message: 'No changes were made to the question',
        question_id: questionId
      });
    }

    // Fetch and return updated question
    const updatedQuestion = await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });

    res.json({
      message: 'Question updated successfully',
      question: {
        id: updatedQuestion._id,
        question_text: updatedQuestion.question_text,
        phase: updatedQuestion.phase,
        severity: updatedQuestion.severity,
        order: updatedQuestion.order,
        is_active: updatedQuestion.is_active,
        updated_at: updatedQuestion.updated_at
      }
    });

  } catch (error) {
    console.error('Failed to update question:', error);
    res.status(500).json({ error: 'Failed to update question' });
  }
});

app.post('/api/admin/questions/bulk', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        error: 'Questions array is required and must contain at least one question'
      });
    }

    if (questions.length > 1000) {
      return res.status(400).json({
        error: 'Maximum 1000 questions allowed per bulk upload'
      });
    }

    // Validation results
    const validationErrors = [];
    const validQuestions = [];

    // Validate each question
    questions.forEach((question, index) => {
      const errors = [];

      // Required fields validation
      if (!question.question_text || typeof question.question_text !== 'string' || question.question_text.trim() === '') {
        errors.push('question_text is required and must be a non-empty string');
      }

      if (!question.phase || typeof question.phase !== 'string' || question.phase.trim() === '') {
        errors.push('phase is required and must be a non-empty string');
      }

      if (!question.severity || typeof question.severity !== 'string' || question.severity.trim() === '') {
        errors.push('severity is required and must be a non-empty string');
      }

      // Optional fields validation
      if (question.order !== undefined && (!Number.isInteger(question.order) || question.order < 1)) {
        errors.push('order must be a positive integer');
      }

      if (question.is_active !== undefined && typeof question.is_active !== 'boolean') {
        errors.push('is_active must be a boolean');
      }

      // Valid severity values
      const validSeverities = ['mandatory', 'optional'];
      if (question.severity && !validSeverities.includes(question.severity.toLowerCase())) {
        errors.push(`severity must be one of: ${validSeverities.join(', ')}`);
      }

      if (errors.length > 0) {
        validationErrors.push({
          index: index,
          question_text: question.question_text || 'N/A',
          errors: errors
        });
      } else {
        // Prepare valid question for insertion
        validQuestions.push({
          question_text: question.question_text.trim(),
          phase: question.phase.trim(),
          severity: question.severity.toLowerCase(),
          order: question.order || 1,
          is_active: question.is_active !== undefined ? question.is_active : true,
          created_at: new Date(),
          created_by: req.user._id
        });
      }
    });

    // If there are validation errors, return them
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed for some questions',
        validation_errors: validationErrors,
        valid_questions_count: validQuestions.length,
        invalid_questions_count: validationErrors.length
      });
    }

    // Check for duplicate questions (same question_text and phase)
    const duplicateCheck = [];
    const questionMap = new Map();

    validQuestions.forEach((question, index) => {
      const key = `${question.question_text.toLowerCase()}-${question.phase.toLowerCase()}`;
      if (questionMap.has(key)) {
        duplicateCheck.push({
          index: index,
          question_text: question.question_text,
          phase: question.phase,
          duplicate_of_index: questionMap.get(key)
        });
      } else {
        questionMap.set(key, index);
      }
    });

    if (duplicateCheck.length > 0) {
      return res.status(400).json({
        error: 'Duplicate questions found in the payload',
        duplicates: duplicateCheck
      });
    }

    // Check for existing questions in database
    const existingQuestions = await db.collection('global_questions').find(
      {
        $or: validQuestions.map(q => ({
          question_text: { $regex: new RegExp(`^${q.question_text}$`, 'i') },
          phase: { $regex: new RegExp(`^${q.phase}$`, 'i') }
        }))
      }
    ).toArray();

    if (existingQuestions.length > 0) {
      return res.status(400).json({
        error: 'Some questions already exist in the database',
        existing_questions: existingQuestions.map(q => ({
          question_text: q.question_text,
          phase: q.phase,
          existing_id: q._id
        }))
      });
    }

    // Insert all valid questions
    const result = await db.collection('global_questions').insertMany(validQuestions);

    res.json({
      message: 'Questions uploaded successfully',
      inserted_count: result.insertedCount,
      inserted_ids: result.insertedIds,
      questions_summary: {
        total_processed: questions.length,
        successfully_inserted: result.insertedCount,
        failed: 0
      }
    });

  } catch (error) {
    console.error('Bulk questions upload failed:', error);
    res.status(500).json({ error: 'Failed to upload questions' });
  }
});

// ===============================
// CONVERSATIONS API
// =============================== 

app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id, user_id } = req.query;

    // Determine which user's conversations to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's conversations
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users conversations' });
      }

      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      targetUserId = new ObjectId(req.user._id);
    }

    // Get questions for the phase
    let questionFilter = { is_active: true };
    if (phase) questionFilter.phase = phase;

    const questions = await db.collection('global_questions')
      .find(questionFilter)
      .sort({ order: 1 })
      .toArray();

    // Get user's conversations
    const conversations = await db.collection('user_business_conversations')
      .find({
        user_id: targetUserId,
        conversation_type: 'question_answer',
        business_id: business_id ? new ObjectId(business_id) : null
      })
      .sort({ created_at: 1 })
      .toArray();

    // Get phase analysis results - UPDATED to handle phase-specific strategic analysis
    const phaseAnalysis = await db.collection('user_business_conversations')
      .find({
        user_id: targetUserId,
        conversation_type: 'phase_analysis',
        business_id: business_id ? new ObjectId(business_id) : null,
        ...(phase && { 'metadata.phase': phase })
      })
      .sort({ created_at: -1 })
      .toArray();

    // Process each question
    const result = questions.map(question => {
      const questionConvs = conversations.filter(c =>
        c.question_id && c.question_id.toString() === question._id.toString()
      );

      const allEntries = questionConvs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // Check if question is skipped
      const isSkipped = allEntries.some(entry => entry.is_skipped === true);

      // Build conversation flow
      const conversationFlow = [];
      allEntries.forEach(entry => {
        if (entry.message_type === 'bot' && entry.message_text) {
          conversationFlow.push({
            type: 'question',
            text: entry.message_text,
            timestamp: entry.created_at,
            is_followup: entry.is_followup || false
          });
        }
        if (entry.answer_text && entry.answer_text.trim() !== '') {
          conversationFlow.push({
            type: 'answer',
            text: entry.answer_text,
            timestamp: entry.created_at,
            is_followup: entry.is_followup || false
          });
        }
      });

      // Determine completion status
      const statusEntries = questionConvs.filter(c => c.metadata && c.metadata.is_complete !== undefined);
      const latestStatusEntry = statusEntries.length > 0
        ? statusEntries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
        : null;

      let status = 'incomplete';
      if (isSkipped) {
        status = 'skipped';
      } else if (latestStatusEntry?.metadata?.is_complete) {
        status = 'complete';
      }

      const answerCount = conversationFlow.filter(item => item.type === 'answer').length;

      return {
        question_id: question._id,
        question_text: question.question_text,
        phase: question.phase,
        order: question.order,

        conversation_flow: conversationFlow,
        total_interactions: conversationFlow.length,
        total_answers: answerCount,
        completion_status: status,
        is_skipped: isSkipped,
        last_updated: allEntries.length > 0 ? allEntries[allEntries.length - 1].created_at : null
      };
    });

    // UPDATED: Organize analysis results by phase AND analysis type
    const analysisResultsByPhase = {};

    phaseAnalysis.forEach(analysis => {
      const analysisPhase = analysis.metadata?.phase || 'initial';
      const analysisType = analysis.metadata?.analysis_type || 'unknown';

      if (!analysisResultsByPhase[analysisPhase]) {
        analysisResultsByPhase[analysisPhase] = {
          phase: analysisPhase,
          analyses: []
        };
      }

      // For strategic analysis, keep both initial and essential phases separate
      const existingIndex = analysisResultsByPhase[analysisPhase].analyses
        .findIndex(a => a.analysis_type === analysisType);

      const analysisData = {
        analysis_type: analysisType,
        analysis_name: analysis.message_text || `${analysisType.toUpperCase()} Analysis`,
        analysis_data: analysis.analysis_result,
        created_at: analysis.created_at,
        phase: analysisPhase
      };

      if (existingIndex !== -1) {
        // Replace if this one is newer
        if (new Date(analysis.created_at) > new Date(analysisResultsByPhase[analysisPhase].analyses[existingIndex].created_at)) {
          analysisResultsByPhase[analysisPhase].analyses[existingIndex] = analysisData;
        }
      } else {
        analysisResultsByPhase[analysisPhase].analyses.push(analysisData);
      }
    });

    res.json({
      conversations: result,
      phase_analysis: analysisResultsByPhase,
      total_questions: questions.length,
      completed: result.filter(r => r.completion_status === 'complete').length,
      skipped: result.filter(r => r.completion_status === 'skipped').length,
      phase: phase || 'all',
      user_id: targetUserId.toString()
    });

  } catch (error) {
    console.error('Failed to fetch conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});


// Get user businesses (for admin viewing other users' businesses)
app.get('/api/businesses', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.query;

    // Determine which user's businesses to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's businesses
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users businesses' });
      }

      // Validate user exists and access permissions
      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Company admin can only view users from their company
      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      // Regular user requesting their own businesses
      targetUserId = new ObjectId(req.user._id);
    }

    const businesses = await db.collection('user_businesses')
      .find({ user_id: targetUserId })
      .sort({ created_at: -1 })
      .toArray();

    // Get total active questions count
    const totalQuestions = await db.collection('global_questions')
      .countDocuments({ is_active: true });

    // Enhanced businesses with question statistics
    const enhancedBusinesses = await Promise.all(
      businesses.map(async (business) => {
        // Get all conversations for this business
        const conversations = await db.collection('user_business_conversations')
          .find({
            user_id: targetUserId,
            business_id: business._id,
            conversation_type: 'question_answer'
          })
          .toArray();

        // Group conversations by question_id to find completion status
        const questionStats = {};

        conversations.forEach(conv => {
          if (conv.question_id) {
            const questionId = conv.question_id.toString();

            // Initialize question stats if not exists
            if (!questionStats[questionId]) {
              questionStats[questionId] = {
                hasAnswers: false,
                isComplete: false,
                answerCount: 0
              };
            }

            // Check if there are actual answers
            if (conv.answer_text && conv.answer_text.trim() !== '') {
              questionStats[questionId].hasAnswers = true;
              questionStats[questionId].answerCount++;
            }

            // Check completion status from metadata
            if (conv.metadata && conv.metadata.is_complete === true) {
              questionStats[questionId].isComplete = true;
            }
          }
        });

        // Count completed and pending questions
        const completedQuestions = Object.values(questionStats).filter(
          stat => stat.isComplete || stat.hasAnswers
        ).length;

        const pendingQuestions = totalQuestions - completedQuestions;

        // Calculate progress percentage
        const progressPercentage = totalQuestions > 0
          ? Math.round((completedQuestions / totalQuestions) * 100)
          : 0;

        return {
          ...business,
          question_statistics: {
            total_questions: totalQuestions,
            completed_questions: completedQuestions,
            pending_questions: pendingQuestions,
            progress_percentage: progressPercentage,
            total_answers_given: Object.values(questionStats).reduce(
              (sum, stat) => sum + stat.answerCount, 0
            )
          }
        };
      })
    );

    res.json({
      businesses: enhancedBusinesses,
      overall_stats: {
        total_businesses: businesses.length,
        total_questions_in_system: totalQuestions
      },
      user_id: targetUserId.toString() // Include the user ID in response for admin context
    });
  } catch (error) {
    console.error('Failed to fetch businesses:', error);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// Get phase analysis results (updated for admin access)
app.get('/api/phase-analysis', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id, analysis_type, user_id } = req.query;

    // Determine which user's phase analysis to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's phase analysis
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users phase analysis' });
      }

      // Validate user exists and access permissions
      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Company admin can only view users from their company
      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      // Regular user requesting their own phase analysis
      targetUserId = new ObjectId(req.user._id);
    }

    let filter = {
      user_id: targetUserId,
      conversation_type: 'phase_analysis'
    };

    if (business_id) filter.business_id = new ObjectId(business_id);
    if (phase) filter['metadata.phase'] = phase;
    if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

    const analysisResults = await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    const formattedResults = analysisResults.map(analysis => ({
      analysis_id: analysis._id,
      phase: analysis.metadata?.phase,
      analysis_type: analysis.metadata?.analysis_type,
      analysis_name: analysis.message_text,
      analysis_data: analysis.analysis_result,
      created_at: analysis.created_at
    }));

    // Group by phase
    const resultsByPhase = formattedResults.reduce((acc, result) => {
      const phase = result.phase || 'unknown';
      if (!acc[phase]) {
        acc[phase] = [];
      }
      acc[phase].push(result);
      return acc;
    }, {});

    res.json({
      analysis_results: formattedResults,
      results_by_phase: resultsByPhase,
      total_analyses: formattedResults.length,
      user_id: targetUserId.toString() // Include the user ID in response for admin context
    });

  } catch (error) {
    console.error('Failed to fetch phase analysis:', error);
    res.status(500).json({ error: 'Failed to fetch phase analysis' });
  }
});

// Enhanced admin endpoint to get user data (conversations + businesses + phase analysis)
app.get('/api/admin/user-data/:user_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    const { business_id } = req.query;

    if (!ObjectId.isValid(user_id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Validate user exists and access permissions
    const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Company admin can only view users from their company
    if (req.user.role.role_name === 'company_admin') {
      if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
        return res.status(403).json({ error: 'Access denied - user not in your company' });
      }
    }

    const targetUserId = new ObjectId(user_id);

    // Build conversation filter
    let conversationFilter = {
      user_id: targetUserId,
      conversation_type: 'question_answer'
    };

    // Build phase analysis filter
    let phaseAnalysisFilter = {
      user_id: targetUserId,
      conversation_type: 'phase_analysis'
    };

    // Build business filter
    let businessFilter = { user_id: targetUserId };

    // If business_id is specified, filter data for that business only
    if (business_id && ObjectId.isValid(business_id)) {
      const businessObjectId = new ObjectId(business_id);
      conversationFilter.business_id = businessObjectId;
      phaseAnalysisFilter.business_id = businessObjectId;

      // Also validate that the business belongs to the user
      const businessExists = await db.collection('user_businesses').findOne({
        _id: businessObjectId,
        user_id: targetUserId
      });

      if (!businessExists) {
        return res.status(404).json({ error: 'Business not found for this user' });
      }
    }

    // Get all conversations for this user (and business if specified)
    const conversations = await db.collection('user_business_conversations')
      .find(conversationFilter)
      .sort({ created_at: 1 })
      .toArray();

    // Get all phase analysis for this user (and business if specified)
    const phaseAnalysis = await db.collection('user_business_conversations')
      .find(phaseAnalysisFilter)
      .sort({ created_at: -1 })
      .toArray();

    // Get all businesses for this user (always return all businesses for dropdown)
    const businesses = await db.collection('user_businesses')
      .find(businessFilter)
      .sort({ created_at: -1 })
      .toArray();

    // Get all questions for reference
    const questions = await db.collection('global_questions')
      .find({ is_active: true })
      .sort({ order: 1 })
      .toArray();

    // Transform conversations into phases structure
    const phaseMap = new Map();

    // Group conversations by question and build phase structure
    questions.forEach(question => {
      const questionConvs = conversations.filter(c =>
        c.question_id && c.question_id.toString() === question._id.toString()
      );

      if (questionConvs.length > 0) {
        const phase = question.phase;

        if (!phaseMap.has(phase)) {
          phaseMap.set(phase, {
            phase: phase,
            severity: question.severity || 'mandatory',
            questions: []
          });
        }

        const phaseData = phaseMap.get(phase);

        // Get all entries for this question (ordered by creation time)
        const allEntries = questionConvs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Build conversation flow
        const conversationFlow = [];
        let finalAnswer = '';

        allEntries.forEach(entry => {
          if (entry.message_type === 'bot' && entry.message_text) {
            conversationFlow.push({
              type: 'question',
              text: entry.message_text,
              timestamp: entry.created_at,
              is_followup: entry.is_followup || false
            });
          }
          if (entry.answer_text && entry.answer_text.trim() !== '') {
            conversationFlow.push({
              type: 'answer',
              text: entry.answer_text,
              timestamp: entry.created_at,
              is_followup: entry.is_followup || false
            });
            finalAnswer = entry.answer_text; // Keep track of the final answer
          }
        });

        // Check completion status
        const statusEntries = questionConvs.filter(c => c.metadata && c.metadata.is_complete !== undefined);
        const latestStatusEntry = statusEntries.length > 0
          ? statusEntries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
          : null;
        const isComplete = latestStatusEntry?.metadata?.is_complete || false;

        // Only add to phase if there are actual answers (completed questions)
        if (isComplete && finalAnswer) {
          phaseData.questions.push({
            question: question.question_text,
            answer: finalAnswer,
            question_id: question._id,
            conversation_flow: conversationFlow,
            is_complete: isComplete,
            last_updated: allEntries.length > 0 ? allEntries[allEntries.length - 1].created_at : null
          });
        }
      }
    });

    // Convert phase map to array and filter out empty phases
    const conversationPhases = Array.from(phaseMap.values()).filter(phase => phase.questions.length > 0);

    // Transform phase analysis into system format
    const systemAnalysis = phaseAnalysis.map(analysis => ({
      name: analysis.metadata?.analysis_type || 'unknown_analysis',
      analysis_result: analysis.analysis_result,
      created_at: analysis.created_at,
      phase: analysis.metadata?.phase,
      message_text: analysis.message_text
    }));

    // Calculate statistics
    const totalQuestions = questions.length;
    const completedQuestions = conversationPhases.reduce((sum, phase) => sum + phase.questions.length, 0);

    // Add question statistics to businesses
    const enhancedBusinesses = await Promise.all(
      businesses.map(async (business) => {
        // Get conversations for this specific business
        const businessConversations = await db.collection('user_business_conversations')
          .find({
            user_id: targetUserId,
            business_id: business._id,
            conversation_type: 'question_answer'
          })
          .toArray();

        // Calculate business-specific statistics
        const businessQuestionStats = {};

        businessConversations.forEach(conv => {
          if (conv.question_id) {
            const questionId = conv.question_id.toString();

            if (!businessQuestionStats[questionId]) {
              businessQuestionStats[questionId] = {
                hasAnswers: false,
                isComplete: false,
                answerCount: 0
              };
            }

            if (conv.answer_text && conv.answer_text.trim() !== '') {
              businessQuestionStats[questionId].hasAnswers = true;
              businessQuestionStats[questionId].answerCount++;
            }

            if (conv.metadata && conv.metadata.is_complete === true) {
              businessQuestionStats[questionId].isComplete = true;
            }
          }
        });

        const completedQuestionsForBusiness = Object.values(businessQuestionStats).filter(
          stat => stat.isComplete || stat.hasAnswers
        ).length;

        const progressPercentage = totalQuestions > 0
          ? Math.round((completedQuestionsForBusiness / totalQuestions) * 100)
          : 0;

        return {
          ...business,
          question_statistics: {
            total_questions: totalQuestions,
            completed_questions: completedQuestionsForBusiness,
            pending_questions: totalQuestions - completedQuestionsForBusiness,
            progress_percentage: progressPercentage,
            total_answers_given: Object.values(businessQuestionStats).reduce(
              (sum, stat) => sum + stat.answerCount, 0
            )
          }
        };
      })
    );

    const responseData = {
      user_info: {
        user_id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        created_at: targetUser.created_at
      },
      conversation: conversationPhases,
      system: systemAnalysis,
      businesses: enhancedBusinesses,
      stats: {
        total_questions: totalQuestions,
        completed_questions: completedQuestions,
        completion_percentage: totalQuestions > 0 ? Math.round((completedQuestions / totalQuestions) * 100) : 0,
        total_businesses: enhancedBusinesses.length,
        total_analyses: systemAnalysis.length
      },
      filter_info: {
        filtered_by_business: business_id ? true : false,
        business_id: business_id || null,
        showing_all_businesses: !business_id
      }
    };

    res.json(responseData);

  } catch (error) {
    console.error('Failed to fetch user data:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id } = req.query;

    // Get questions for the phase
    let questionFilter = { is_active: true };
    if (phase) questionFilter.phase = phase;

    const questions = await db.collection('global_questions')
      .find(questionFilter)
      .sort({ order: 1 })
      .toArray();

    // Get user's conversations
    const conversations = await db.collection('user_business_conversations')
      .find({
        user_id: new ObjectId(req.user._id),
        conversation_type: 'question_answer',
        business_id: business_id ? new ObjectId(business_id) : null
      })
      .sort({ created_at: 1 })
      .toArray();

    // Get phase analysis results
    const phaseAnalysis = await db.collection('user_business_conversations')
      .find({
        user_id: new ObjectId(req.user._id),
        conversation_type: 'phase_analysis',
        business_id: business_id ? new ObjectId(business_id) : null,
        ...(phase && { 'metadata.phase': phase })
      })
      .sort({ created_at: -1 })
      .toArray();

    // Process each question
    const result = questions.map(question => {
      const questionConvs = conversations.filter(c =>
        c.question_id && c.question_id.toString() === question._id.toString()
      );

      // Get all conversation entries for this question (ordered by creation time)
      const allEntries = questionConvs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // Build conversation flow with questions and answers
      const conversationFlow = [];
      allEntries.forEach(entry => {
        if (entry.message_type === 'bot' && entry.message_text) {
          // Followup question from bot
          conversationFlow.push({
            type: 'question',
            text: entry.message_text,
            timestamp: entry.created_at,
            is_followup: entry.is_followup || false
          });
        }
        if (entry.answer_text && entry.answer_text.trim() !== '') {
          // User answer
          conversationFlow.push({
            type: 'answer',
            text: entry.answer_text,
            timestamp: entry.created_at,
            is_followup: entry.is_followup || false
          });
        }
      });

      // FIXED: Determine completion status - get the most recent status entry
      const statusEntries = questionConvs.filter(c => c.metadata && c.metadata.is_complete !== undefined);
      const latestStatusEntry = statusEntries.length > 0
        ? statusEntries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
        : null;
      const status = latestStatusEntry?.metadata?.is_complete ? 'complete' : 'incomplete';

      // Count answers only
      const answerCount = conversationFlow.filter(item => item.type === 'answer').length;

      return {
        question_id: question._id,
        question_text: question.question_text,
        phase: question.phase,
        order: question.order,

        conversation_flow: conversationFlow,
        total_interactions: conversationFlow.length,
        total_answers: answerCount,
        completion_status: status,
        last_updated: allEntries.length > 0 ? allEntries[allEntries.length - 1].created_at : null
      };
    });

    const latestAnalysisMap = new Map();

    phaseAnalysis.forEach(analysis => {
      const key = `${analysis.metadata?.phase}-${analysis.metadata?.analysis_type}`;
      if (!latestAnalysisMap.has(key)) {
        latestAnalysisMap.set(key, {
          analysis_type: analysis.metadata?.analysis_type || 'unknown',
          analysis_name: analysis.message_text,
          analysis_data: analysis.analysis_result,
          created_at: analysis.created_at,
          phase: analysis.metadata?.phase
        });
      }
    });

    const analysisResults = Array.from(latestAnalysisMap.values());

    res.json({
      conversations: result,
      phase_analysis: analysisResults,
      total_questions: questions.length,
      completed: result.filter(r => r.completion_status === 'complete').length,
      phase: phase || 'all'
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});
app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const {
      question_id,
      answer_text,
      is_followup = false,
      business_id,
      is_complete = false,
      is_skipped = false,
      metadata
    } = req.body;

    if (!question_id || (!answer_text && !is_skipped)) {
      return res.status(400).json({ error: 'Question ID and answer text (or skip) required' });
    }

    // Check if this is an edit from the brief section
    const isEdit = metadata?.from_editable_brief === true;

    if (isEdit && answer_text && answer_text.trim() !== '') {
      // For edits, update existing conversation instead of creating new one
      const updateResult = await db.collection('user_business_conversations')
        .updateOne(
          {
            user_id: new ObjectId(req.user._id),
            business_id: business_id ? new ObjectId(business_id) : null,
            question_id: new ObjectId(question_id),
            conversation_type: 'question_answer'
          },
          {
            $set: {
              answer_text: answer_text.trim(),
              is_skipped: false, // Un-skip if it was skipped
              metadata: {
                ...metadata,
                is_complete: true,
                is_edit: true
              },
              timestamp: new Date()
            }
          }
        );

      if (updateResult.modifiedCount > 0) {
        return res.json({
          message: 'Answer updated',
          is_complete: true,
          action: 'updated'
        });
      }
    }

    // Original logic for new conversations
    const conversation = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'user',
      message_text: '',
      answer_text: answer_text || '',
      is_followup,
      is_skipped,
      analysis_result: null,
      metadata: {
        ...metadata,
        is_complete,
        is_skipped
      },
      attempt_count: 1,
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(conversation);

    res.json({
      message: is_skipped ? 'Question skipped' : 'Answer saved',
      conversation_id: result.insertedId,
      is_complete,
      is_skipped,
      action: 'created'
    });
  } catch (error) {
    console.error('Error saving conversation:', error);
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});
app.post('/api/conversations/skip', authenticateToken, async (req, res) => {
  try {
    const {
      question_id,
      business_id,
      metadata
    } = req.body;

    if (!question_id) {
      return res.status(400).json({ error: 'Question ID is required' });
    }

    // Validate that the question exists
    const question = await db.collection('global_questions').findOne({
      _id: new ObjectId(question_id)
    });

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    // Create a conversation record for the skipped question
    const conversation = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'user',
      message_text: '',
      answer_text: '[Question Skipped]',
      is_followup: false,
      is_skipped: true,
      analysis_result: null,
      metadata: {
        ...metadata,
        is_complete: true, // Mark as complete since it's skipped
        is_skipped: true,
        skip_reason: 'user_skipped'
      },
      attempt_count: 1,
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(conversation);

    res.json({
      message: 'Question skipped successfully',
      conversation_id: result.insertedId,
      is_complete: true,
      is_skipped: true
    });
  } catch (error) {
    console.error('Failed to skip question:', error);
    res.status(500).json({ error: 'Failed to skip question' });
  }
});
// Save followup question generated by Groq
app.post('/api/conversations/followup-question', authenticateToken, async (req, res) => {
  try {
    const {
      question_id,
      followup_question_text,
      business_id,
      metadata
    } = req.body;

    if (!question_id || !followup_question_text) {
      return res.status(400).json({ error: 'Question ID and followup question text required' });
    }

    const conversation = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'bot',
      message_text: followup_question_text,
      answer_text: null,
      is_followup: true,
      analysis_result: null,
      metadata: metadata || {},
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(conversation);

    res.json({
      message: 'Followup question saved',
      conversation_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save followup question' });
  }
});
app.get('/api/phase-analysis/:phase', authenticateToken, async (req, res) => {
  try {
    const { phase } = req.params;
    const { business_id, analysis_type, user_id } = req.query;

    // Determine which user's phase analysis to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's phase analysis
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users phase analysis' });
      }

      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      targetUserId = new ObjectId(req.user._id);
    }

    let filter = {
      user_id: targetUserId,
      conversation_type: 'phase_analysis',
      'metadata.phase': phase
    };

    if (business_id) filter.business_id = new ObjectId(business_id);
    if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

    const analysisResults = await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    const formattedResults = analysisResults.map(analysis => ({
      analysis_id: analysis._id,
      phase: analysis.metadata?.phase,
      analysis_type: analysis.metadata?.analysis_type,
      analysis_name: analysis.message_text,
      analysis_data: analysis.analysis_result,
      created_at: analysis.created_at
    }));

    // Group by analysis type
    const resultsByType = formattedResults.reduce((acc, result) => {
      const type = result.analysis_type || 'unknown';
      if (!acc[type]) {
        acc[type] = [];
      }
      acc[type].push(result);
      return acc;
    }, {});

    res.json({
      phase: phase,
      analysis_results: formattedResults,
      results_by_type: resultsByType,
      total_analyses: formattedResults.length,
      user_id: targetUserId.toString()
    });

  } catch (error) {
    console.error('Failed to fetch phase analysis:', error);
    res.status(500).json({ error: 'Failed to fetch phase analysis' });
  }
});
// Save phase analysis results (SWOT, Customer Segmentation, etc.)
app.post('/api/conversations/phase-analysis', authenticateToken, async (req, res) => {
  try {
    const {
      phase,
      analysis_type,
      analysis_name,
      analysis_data,
      business_id,
      metadata
    } = req.body;

    if (!phase || !analysis_type || !analysis_name || !analysis_data) {
      return res.status(400).json({ error: 'Phase, analysis type, name, and data are required' });
    }

    // For strategic analysis, ensure we can distinguish between phases
    const enhancedMetadata = {
      phase: phase,
      analysis_type: analysis_type,
      generated_at: new Date().toISOString(),
      ...metadata
    };

    const phaseAnalysis = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: null,
      conversation_type: 'phase_analysis',
      message_type: 'system',
      message_text: analysis_name,
      answer_text: null,
      is_followup: false,
      analysis_result: analysis_data,
      metadata: enhancedMetadata,
      timestamp: new Date(),
      created_at: new Date()
    };

    // For strategic analysis, use upsert to replace existing analysis for the same phase
    const result = await db.collection('user_business_conversations').updateOne(
      {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        conversation_type: 'phase_analysis',
        'metadata.phase': phase,
        'metadata.analysis_type': analysis_type
      },
      {
        $set: phaseAnalysis
      },
      { upsert: true }
    );

    res.json({
      message: 'Phase analysis saved',
      analysis_id: result.insertedId || 'updated',
      analysis_type: analysis_type,
      phase: phase
    });
  } catch (error) {
    console.error('Failed to save phase analysis:', error);
    res.status(500).json({ error: 'Failed to save phase analysis' });
  }
});

// Add API to mark question as complete/incomplete
app.put('/api/conversations/:question_id/status', authenticateToken, async (req, res) => {
  try {
    const { question_id } = req.params;
    const { completion_status, analysis_result } = req.body;

    if (!['complete', 'incomplete'].includes(completion_status)) {
      return res.status(400).json({ error: 'Status must be complete or incomplete' });
    }

    // Create a status update record
    const statusUpdate = {
      user_id: new ObjectId(req.user._id),
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'system',
      message_text: `Question marked as ${completion_status}`,
      answer_text: null,
      is_followup: false,
      analysis_result: analysis_result || null,
      metadata: {
        is_complete: completion_status === 'complete',
        status_update: true
      },
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(statusUpdate);

    res.json({
      message: `Question marked as ${completion_status}`,
      status_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.delete('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { business_id } = req.query;
    let filter = { user_id: new ObjectId(req.user._id) };

    if (business_id) {
      filter.business_id = new ObjectId(business_id);
    }

    const result = await db.collection('user_business_conversations')
      .deleteMany(filter);

    res.json({
      message: 'Conversations cleared',
      deleted_count: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear conversations' });
  }
});

// Get phase analysis results only
app.get('/api/phase-analysis', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id, analysis_type } = req.query;

    let filter = {
      user_id: new ObjectId(req.user._id),
      conversation_type: 'phase_analysis'
    };

    if (business_id) filter.business_id = new ObjectId(business_id);
    if (phase) filter['metadata.phase'] = phase;
    if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

    const analysisResults = await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    const formattedResults = analysisResults.map(analysis => ({
      analysis_id: analysis._id,
      phase: analysis.metadata?.phase,
      analysis_type: analysis.metadata?.analysis_type,
      analysis_name: analysis.message_text,
      analysis_data: analysis.analysis_result,
      created_at: analysis.created_at
    }));

    // Group by phase
    const resultsByPhase = formattedResults.reduce((acc, result) => {
      const phase = result.phase || 'unknown';
      if (!acc[phase]) {
        acc[phase] = [];
      }
      acc[phase].push(result);
      return acc;
    }, {});

    res.json({
      analysis_results: formattedResults,
      results_by_phase: resultsByPhase,
      total_analyses: formattedResults.length
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch phase analysis' });
  }
});

// ===============================
// ADMIN APIs
// ===============================
// Add this GET endpoint to your backend after the existing admin endpoints
// This should go in the ADMIN APIs section
// Updated GET endpoint for /api/admin/companies
app.get('/api/admin/companies', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let matchFilter = {};

    // Filter based on user role
    if (req.user.role.role_name === 'company_admin') {
      // Company admin can only see their own company
      if (!req.user.company_id) {
        return res.status(400).json({ error: 'No company associated with admin account' });
      }
      matchFilter._id = req.user.company_id;
    }
    // Super admin sees all companies (no filter needed)

    // Get companies with their admin details
    const companies = await db.collection('companies').aggregate([
      {
        $match: matchFilter
      },
      {
        $lookup: {
          from: 'users',
          let: { companyId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$company_id', '$$companyId'] },
                role_id: { $exists: true }
              }
            },
            {
              $lookup: {
                from: 'roles',
                localField: 'role_id',
                foreignField: '_id',
                as: 'role'
              }
            },
            {
              $unwind: '$role'
            },
            {
              $match: {
                'role.role_name': 'company_admin'
              }
            },
            {
              $limit: 1
            }
          ],
          as: 'admin'
        }
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
        $addFields: {
          admin_name: { $arrayElemAt: ['$admin.name', 0] },
          admin_email: { $arrayElemAt: ['$admin.email', 0] },
          admin_created_at: { $arrayElemAt: ['$admin.created_at', 0] },
          total_users: { $size: '$users' },
          active_users: {
            $size: {
              $filter: {
                input: '$users',
                cond: { $ne: ['$$this.status', 'inactive'] }
              }
            }
          }
        }
      },
      {
        $project: {
          company_name: 1,
          industry: 1,
          size: 1,
          logo: 1,
          status: 1,
          created_at: 1,
          logo_updated_at: 1,
          admin_name: 1,
          admin_email: 1,
          admin_created_at: 1,
          total_users: 1,
          active_users: 1
        }
      },
      {
        $sort: { created_at: -1 }
      }
    ]).toArray();

    // If no admin found, set default values
    const enhancedCompanies = companies.map(company => ({
      ...company,
      admin_name: company.admin_name || 'No Admin Assigned',
      admin_email: company.admin_email || 'No Email',
      total_users: company.total_users || 0,
      active_users: company.active_users || 0
    }));

    res.json({
      companies: enhancedCompanies,
      total_count: enhancedCompanies.length,
      user_role: req.user.role.role_name,
      filtered_by_company: req.user.role.role_name === 'company_admin'
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/admin/companies', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Get all companies with their admin details
    const companies = await db.collection('companies').aggregate([
      {
        $lookup: {
          from: 'users',
          let: { companyId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$company_id', '$$companyId'] },
                role_id: { $exists: true }
              }
            },
            {
              $lookup: {
                from: 'roles',
                localField: 'role_id',
                foreignField: '_id',
                as: 'role'
              }
            },
            {
              $unwind: '$role'
            },
            {
              $match: {
                'role.role_name': 'company_admin'
              }
            },
            {
              $limit: 1
            }
          ],
          as: 'admin'
        }
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
        $addFields: {
          admin_name: { $arrayElemAt: ['$admin.name', 0] },
          admin_email: { $arrayElemAt: ['$admin.email', 0] },
          admin_created_at: { $arrayElemAt: ['$admin.created_at', 0] },
          total_users: { $size: '$users' },
          active_users: {
            $size: {
              $filter: {
                input: '$users',
                cond: { $ne: ['$$this.status', 'inactive'] }
              }
            }
          }
        }
      },
      {
        $project: {
          company_name: 1,
          industry: 1,
          size: 1,
          logo: 1,
          status: 1,
          created_at: 1,
          logo_updated_at: 1,
          admin_name: 1,
          admin_email: 1,
          admin_created_at: 1,
          total_users: 1,
          active_users: 1
        }
      },
      {
        $sort: { created_at: -1 }
      }
    ]).toArray();

    // If no admin found, set default values
    const enhancedCompanies = companies.map(company => ({
      ...company,
      admin_name: company.admin_name || 'No Admin Assigned',
      admin_email: company.admin_email || 'No Email',
      total_users: company.total_users || 0,
      active_users: company.active_users || 0
    }));

    res.json({
      companies: enhancedCompanies,
      total_count: enhancedCompanies.length
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.post('/api/admin/companies', authenticateToken, requireSuperAdmin, logoUpload.single('logo'), async (req, res) => {
  try {
    const { company_name, industry, size, admin_name, admin_email, admin_password } = req.body;

    if (!company_name || !admin_name || !admin_email || !admin_password) {
      return res.status(400).json({ error: 'Company name and admin details required' });
    }

    // Check if admin email exists
    const existingUser = await db.collection('users').findOne({ email: admin_email });
    if (existingUser) {
      return res.status(400).json({ error: 'Admin email already exists' });
    }

    // Handle logo if uploaded
    let logoUrl = null;
    if (req.file) {
      logoUrl = `${req.protocol}://${req.get('host')}/uploads/logos/${req.file.filename}`;
    }

    // Create company with logo
    const companyResult = await db.collection('companies').insertOne({
      company_name,
      industry: industry || '',
      size: size || '',
      logo: logoUrl,
      status: 'active',
      created_at: new Date(),
      logo_updated_at: logoUrl ? new Date() : null
    });

    // Create company admin
    const companyAdminRole = await db.collection('roles').findOne({ role_name: 'company_admin' });
    const hashedPassword = await bcrypt.hash(admin_password, 12);

    const adminResult = await db.collection('users').insertOne({
      name: admin_name,
      email: admin_email,
      password: hashedPassword,
      role_id: companyAdminRole._id,
      company_id: companyResult.insertedId,
      created_at: new Date()
    });

    res.json({
      message: 'Company and admin created successfully',
      company_id: companyResult.insertedId,
      admin_id: adminResult.insertedId,
      logo_url: logoUrl
    });

  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

app.post('/api/admin/questions', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { question_text, phase, severity, order } = req.body;

    if (!question_text || !phase || !severity) {
      return res.status(400).json({ error: 'Question text, phase, and severity required' });
    }

    const result = await db.collection('global_questions').insertOne({
      question_text,
      phase,
      severity,
      order: order || 1,
      is_active: true,
      created_at: new Date()
    });

    res.json({
      message: 'Question created',
      question_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create question' });
  }
});

// Company Admin APIs
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { company_id } = req.query;
    let filter = {};

    // Handle company filtering based on user role
    if (req.user.role.role_name === 'company_admin') {
      // Company admin can only see users from their own company
      filter.company_id = req.user.company_id;
    } else if (req.user.role.role_name === 'super_admin') {
      // Super admin can filter by specific company if provided
      if (company_id) {
        try {
          filter.company_id = new ObjectId(company_id);
        } catch (error) {
          return res.status(400).json({ error: 'Invalid company ID format' });
        }
      }
      // If no company_id provided, show all users (no additional filter)
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
      { $unwind: { path: '$role', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          email: 1,
          created_at: 1,
          role_name: '$role.role_name',
          company_name: '$company.company_name',
          company_id: 1 // Include company_id for debugging
        }
      },
      { $sort: { created_at: -1 } }
    ]).toArray();

    res.json({
      users,
      filter_applied: filter,
      total_count: users.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }

    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    let companyId = req.user.company_id;
    if (req.user.role.role_name === 'super_admin' && req.body.company_id) {
      companyId = new ObjectId(req.body.company_id);
    }

    if (!companyId) {
      return res.status(400).json({ error: 'Company ID required' });
    }

    const userRole = await db.collection('roles').findOne({ role_name: 'user' });
    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await db.collection('users').insertOne({
      name,
      email,
      password: hashedPassword,
      role_id: userRole._id,
      company_id: companyId,
      created_at: new Date()
    });

    res.json({
      message: 'User created',
      user_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/companies/:id/logo', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const companyId = req.params.id;
    const { logo } = req.body;

    if (!logo) {
      return res.status(400).json({ error: 'Logo is required' });
    }

    // Validate company access for company admin
    if (req.user.role.role_name === 'company_admin') {
      if (req.user.company_id.toString() !== companyId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const result = await db.collection('companies').updateOne(
      { _id: new ObjectId(companyId) },
      {
        $set: {
          logo: logo,
          logo_updated_at: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ message: 'Company logo updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update company logo' });
  }
});

// ===============================
// HEALTH CHECK
// ===============================
app.get('/debug', async (req, res) => {
  try {
    res.json({
      env_mongo_uri: process.env.MONGO_URI ? 'SET' : 'NOT SET',
      used_mongo_uri: MONGO_URI.replace(/\/\/.*:.*@/, '//***:***@'),
      database_name: db ? db.databaseName : 'NOT CONNECTED',
      collections: db ? await db.listCollections().toArray() : []
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});
app.get('/health', async (req, res) => {
  try {
    const stats = await Promise.all([
      db.collection('companies').countDocuments(),
      db.collection('users').countDocuments(),
      db.collection('global_questions').countDocuments(),
      db.collection('user_businesses').countDocuments(),
      db.collection('user_business_conversations').countDocuments()
    ]);

    res.json({
      status: 'healthy',
      database: 'connected',
      stats: {
        companies: stats[0],
        users: stats[1],
        questions: stats[2],
        businesses: stats[3],
        conversations: stats[4]
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Logo file size too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: `File upload error: ${error.message}` });
  }

  if (error.message.includes('Invalid file type')) {
    return res.status(400).json({ error: error.message });
  }

  next(error);
});
// ===============================
// START SERVER
// ===============================

connectToMongoDB().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Traxxia API running on port ${port}`);
    console.log(`Server accessible at: http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});