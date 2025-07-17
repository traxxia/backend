const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const multer = require('multer');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;
const secretKey = process.env.SECRET_KEY || 'default_secret_key';

app.use(bodyParser.json());
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_survey';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true 
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// User Schema
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['user', 'admin'], 
    default: 'user' 
  },
  company: String,
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Current Questions Schema with versioning
const currentQuestionsSchema = new mongoose.Schema({
  questions: { type: Array, required: true },
  version: { type: String, required: true },
  updated_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  updated_at: { type: Date, default: Date.now }
});

const CurrentQuestions = mongoose.model('CurrentQuestions', currentQuestionsSchema);

// Survey Responses Schema with version tracking
const surveyResponseSchema = new mongoose.Schema({
  user_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  question_set_version: { type: String, required: true },
  questions: { type: Array, required: true },
  answers: { type: Array, required: true },
  submitted_at: { type: Date, default: Date.now }
});

// Compound index to ensure one response per user per question set version
surveyResponseSchema.index({ user_id: 1, question_set_version: 1 }, { unique: true });

const SurveyResponse = mongoose.model('SurveyResponse', surveyResponseSchema);

<<<<<<< HEAD
// ===============================
// NEW: AUDIT TRAIL SCHEMA
// ===============================

// Simple Audit Trail Schema - just add this one schema
const auditTrailSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  business_name: { type: String, required: true },
  
  // Survey data (questions and answers)
  survey_data: {
    version: String,
    questions: { type: Array, required: true }, // All questions from your survey
    answers: { type: Array, required: true },   // All answers from user
    completion_percentage: Number,
    submitted_at: Date
  },
  
  // Analysis result data  
  analysis_data: {
    analysis_type: String,        // swot, porter, pestle, etc.
    analysis_framework: String,   // framework name
    category: String,             // analysis or strategic
    generated_result: { type: mongoose.Schema.Types.Mixed, required: true }, // The actual analysis result
    groq_request_details: {
      model: String,
      tokens_used: Number,
      response_time_ms: Number
    }
  },
  
  // Save details
  save_details: {
    title: { type: String, required: true },
    description: String,
    tags: [String]
  },
  
  // Timestamps
  created_at: { type: Date, default: Date.now },
  analysis_generated_at: Date,
  saved_at: { type: Date, default: Date.now }
});

auditTrailSchema.index({ user_id: 1, created_at: -1 });
auditTrailSchema.index({ business_name: 1 });

const AuditTrail = mongoose.model('AuditTrail', auditTrailSchema);

=======
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
// Simple CSV conversion function
function convertToCSV(data) {
  if (!data || !data.length) return '';
  
  const headers = Object.keys(data[0]);
  const csvRows = [];
  
  csvRows.push(headers.map(header => `"${header}"`).join(','));
  
  data.forEach(row => {
    const values = headers.map(header => {
      const value = row[header] || '';
      return `"${String(value).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  });
  
  return csvRows.join('\n');
}

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are allowed'), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).send({ message: 'No token provided' });

  jwt.verify(token, secretKey, (err, user) => {
    if (err) return res.status(403).send({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send({ message: 'Admin access required' });
  }
  next();
};

// ===============================
// 1. SECURE USER CREATION & AUTHENTICATION - PRIVILEGE ESCALATION FIXED
// ===============================

app.post('/api/users', async (req, res) => {
  try {
    // SECURITY FIX: REMOVED role from destructuring - privilege escalation vulnerability FIXED
    const { name, email, password, company } = req.body;

    if (!name || !email || !password) {
      return res.status(400).send({ message: 'Name, email, and password are required' });
    }

    // Enhanced validation
    if (name.length < 2 || name.length > 50) {
      return res.status(400).send({ message: 'Name must be between 2 and 50 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).send({ message: 'Please provide a valid email address' });
    }

    if (password.length < 8) {
      return res.status(400).send({ message: 'Password must be at least 8 characters long' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).send({ message: 'User already exists with this email' });
    }

    const hashedPassword = await bcrypt.hash(password, 12); // Increased salt rounds for security

    const newUser = new User({ 
      name, 
      email, 
      password: hashedPassword, 
      role: 'user',  
      company 
    });

    await newUser.save();
 
    res.status(201).send({ 
      message: 'User created successfully',
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role 
      }
    });
  } catch (error) {
    console.error('User creation error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).send({ message: 'Email and password are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).send({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).send({ message: 'Invalid credentials' });
    }

    // Enhanced JWT payload
    const token = jwt.sign({ 
      id: user._id, 
      email: user.email, 
      role: user.role 
    }, secretKey, { expiresIn: '24h' });
    
    // Get latest question set version
    const latestQuestionSet = await CurrentQuestions.findOne().sort({ updated_at: -1 });
    const latestVersion = latestQuestionSet ? latestQuestionSet.version : null;
    
    res.status(200).send({ 
      message: 'Login successful', 
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      latest_version: latestVersion
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// 2. QUESTION SET MANAGEMENT (Admin only) - Generic for all versions
// ===============================

app.post('/api/admin/upload-questions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { questions, version } = req.body;

    if (!questions || !Array.isArray(questions)) {
      return res.status(400).send({ message: 'Questions array is required' });
    }

    if (!version) {
      return res.status(400).send({ message: 'Version is required' });
    }

    // Check if version already exists
    const existingVersion = await CurrentQuestions.findOne({ version });
    if (existingVersion) {
      return res.status(400).send({ message: `Version ${version} already exists` });
    }

<<<<<<< HEAD
    // Validate and ensure all questions have severity and phase fields
    const processedQuestions = questions.map(category => ({
      ...category,
      questions: category.questions ? category.questions.map(question => {
        // Validate severity field
        const severity = question.severity || 'mandatory';
        if (!['mandatory', 'optional'].includes(severity)) {
          throw new Error(`Invalid severity "${severity}" for question: ${question.question}. Must be 'mandatory' or 'optional'.`);
        }

        // Validate phase field  
        const phase = question.phase || 'initial';
        if (!['initial', 'essential', 'good', 'excellent'].includes(phase)) {
          throw new Error(`Invalid phase "${phase}" for question: ${question.question}. Must be 'initial', 'essential', 'good', or 'excellent'.`);
        }

        return {
          ...question,
          severity: severity,
          phase: phase
        };
      }) : []
    }));

    // Create new question set
    const newQuestions = new CurrentQuestions({
      questions: processedQuestions,
=======
    // Create new question set
    const newQuestions = new CurrentQuestions({
      questions: questions,
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
      version: version,
      updated_by: req.user.id
    });

    await newQuestions.save();

<<<<<<< HEAD
    // Calculate statistics
    const stats = {
      totalCategories: processedQuestions.length,
      totalQuestions: processedQuestions.reduce((sum, cat) => sum + (cat.questions ? cat.questions.length : 0), 0),
      severityBreakdown: {
        mandatory: 0,
        optional: 0
      },
      phaseBreakdown: {
        initial: 0,
        essential: 0,
        good: 0,
        excellent: 0
      }
    };

    // Calculate breakdown statistics
    processedQuestions.forEach(category => {
      if (category.questions) {
        category.questions.forEach(question => {
          stats.severityBreakdown[question.severity]++;
          stats.phaseBreakdown[question.phase]++;
        });
      }
    });

    res.status(200).send({ 
      message: 'Questions uploaded successfully',
      version: version,
      statistics: stats
=======
    res.status(200).send({ 
      message: 'Questions uploaded successfully',
      version: version,
      totalCategories: questions.length,
      totalQuestions: questions.reduce((sum, cat) => sum + (cat.questions ? cat.questions.length : 0), 0)
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
    });

  } catch (error) {
    console.error('Upload questions error:', error);
    res.status(500).send({ message: 'Upload failed', error: error.message });
  }
});

// Get latest questions for users (always returns most recent version)
app.get('/api/questions', authenticateToken, async (req, res) => {
  try {
    // Always get the latest version
    const currentQuestions = await CurrentQuestions.findOne().sort({ updated_at: -1 });
    
    if (!currentQuestions) {
      return res.status(404).send({ message: 'No questions available' });
    }

    res.status(200).send({ 
      questions: currentQuestions.questions,
      version: currentQuestions.version
    });
  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// 3. SURVEY RESPONSE MANAGEMENT
// ===============================

app.post('/api/survey/submit', authenticateToken, async (req, res) => {
  try {
    const { answers, version } = req.body;

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).send({ message: 'Answers array is required' });
    }

    // Get question set (specific version or latest)
    let questionSet;
    if (version) {
      questionSet = await CurrentQuestions.findOne({ version });
    } else {
      questionSet = await CurrentQuestions.findOne().sort({ updated_at: -1 });
    }

    if (!questionSet) {
      return res.status(404).send({ message: 'Question set not found' });
    }

    // Delete existing response for this user and version (allows overwrite/resubmission)
    await SurveyResponse.deleteOne({ 
      user_id: req.user.id,
      question_set_version: questionSet.version
    });

    // Save the new response
    const surveyResponse = new SurveyResponse({
      user_id: req.user.id,
      question_set_version: questionSet.version,
      questions: questionSet.questions,
      answers: answers
    });

    await surveyResponse.save();

    res.status(200).send({ 
      message: 'Survey submitted successfully',
      response_id: surveyResponse._id,
      version: questionSet.version
    });

  } catch (error) {
    console.error('Submit survey error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.get('/api/survey/my-responses', authenticateToken, async (req, res) => {
  try {
    const responses = await SurveyResponse.find({ user_id: req.user.id })
      .sort({ submitted_at: -1 });

    const responseData = responses.map(response => ({
      version: response.question_set_version,
      submitted_at: response.submitted_at,
      totalAnswers: response.answers.length
    }));

    res.status(200).send({ 
      responses: responseData
    });
  } catch (error) {
    console.error('Get user responses error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// 4. ADMIN USER MANAGEMENT
// ===============================

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { role } = req.query; // ?role=user or ?role=admin or omit for all
    
    // Build query based on role parameter
    let query = {};
    if (role && ['user', 'admin'].includes(role)) {
      query.role = role;
    }

    const users = await User.find(query)
      .select('name email company role created_at')
      .sort({ created_at: -1 });

    const usersWithStatus = await Promise.all(
      users.map(async (user) => {
        // Get all responses for this user across all versions
        const responses = await SurveyResponse.find({ user_id: user._id })
          .sort({ submitted_at: -1 });
        
        return {
          id: user._id,
          name: user.name,
          email: user.email,
          company: user.company || '',
          role: user.role,
          created_at: user.created_at,
          total_responses: responses.length,
          latest_response: responses.length > 0 ? {
            version: responses[0].question_set_version,
            submitted_at: responses[0].submitted_at
          } : null
        };
      })
    );

    res.status(200).send({ 
      users: usersWithStatus,
      total: usersWithStatus.length,
      filter_applied: role || 'none'
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
<<<<<<< HEAD
// NEW: AUDIT TRAIL APIs
// ===============================

// API 1: POST - Save Audit Trail (when user clicks save)
app.post('/api/audit-trail/save', authenticateToken, async (req, res) => {
  try {
    const {
      business_name,
      survey_data,           // {version, questions, answers, completion_percentage}
      analysis_data,         // {analysis_type, framework, category, result, groq_details}
      save_details          // {title, description, tags}
    } = req.body;

    // Validation
    if (!business_name || !survey_data || !analysis_data || !save_details?.title) {
      return res.status(400).send({ 
        message: 'Business name, survey data, analysis data, and save title are required' 
      });
    }

    // Create audit trail entry
    const auditEntry = new AuditTrail({
      user_id: req.user.id,
      business_name: business_name.trim(),
      
      survey_data: {
        version: survey_data.version || 'unknown',
        questions: survey_data.questions || [],
        answers: survey_data.answers || [],
        completion_percentage: survey_data.completion_percentage || 0,
        submitted_at: survey_data.submitted_at || new Date()
      },
      
      analysis_data: {
        analysis_type: analysis_data.analysis_type,
        analysis_framework: analysis_data.analysis_framework,
        category: analysis_data.category,
        generated_result: analysis_data.generated_result,
        groq_request_details: analysis_data.groq_request_details || {}
      },
      
      save_details: {
        title: save_details.title.trim(),
        description: save_details.description?.trim() || '',
        tags: Array.isArray(save_details.tags) ? save_details.tags : []
      },
      
      analysis_generated_at: analysis_data.generated_at || new Date()
    });

    await auditEntry.save();

    console.log(`✅ Audit trail saved: ${save_details.title} for ${business_name}`);

    res.status(201).send({
      message: 'Audit trail saved successfully',
      audit_id: auditEntry._id,
      title: auditEntry.save_details.title,
      created_at: auditEntry.created_at
    });

  } catch (error) {
    console.error('Save audit trail error:', error);
    res.status(500).send({ 
      message: 'Failed to save audit trail', 
      error: error.message 
    });
  }
});

// API 2: GET - Get Audit Trail History
app.get('/api/audit-trail/history', authenticateToken, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      business_name,    // Filter by business name
      analysis_type,    // Filter by analysis type (swot, porter, etc.)
      date_from,        // Filter from date
      date_to,          // Filter to date
      search           // Search in title/description
    } = req.query;

    // Build query for current user
    const query = { user_id: req.user.id };

    // Apply filters
    if (business_name) {
      query.business_name = { $regex: business_name, $options: 'i' };
    }

    if (analysis_type) {
      query['analysis_data.analysis_type'] = analysis_type;
    }

    if (date_from || date_to) {
      query.created_at = {};
      if (date_from) query.created_at.$gte = new Date(date_from);
      if (date_to) query.created_at.$lte = new Date(date_to);
    }

    if (search) {
      query.$or = [
        { 'save_details.title': { $regex: search, $options: 'i' } },
        { 'save_details.description': { $regex: search, $options: 'i' } },
        { business_name: { $regex: search, $options: 'i' } }
      ];
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [auditHistory, totalCount] = await Promise.all([
      AuditTrail.find(query)
        .populate('user_id', 'name email')
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      AuditTrail.countDocuments(query)
    ]);

    // Format response
    const formattedHistory = auditHistory.map(entry => ({
      id: entry._id,
      business_name: entry.business_name,
      
      // Save details
      title: entry.save_details.title,
      description: entry.save_details.description,
      tags: entry.save_details.tags,
      
      // Survey summary
      survey_summary: {
        version: entry.survey_data.version,
        total_questions: entry.survey_data.questions.length,
        total_answers: entry.survey_data.answers.length,
        completion_percentage: entry.survey_data.completion_percentage,
        submitted_at: entry.survey_data.submitted_at
      },
      
      // Analysis summary
      analysis_summary: {
        type: entry.analysis_data.analysis_type,
        framework: entry.analysis_data.analysis_framework,
        category: entry.analysis_data.category,
        generated_at: entry.analysis_generated_at
      },
      
      // User info
      user: entry.user_id ? {
        name: entry.user_id.name,
        email: entry.user_id.email
      } : null,
      
      // Timestamps
      created_at: entry.created_at,
      saved_at: entry.saved_at
    }));

    res.status(200).send({
      audit_history: formattedHistory,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(totalCount / parseInt(limit)),
        total_count: totalCount,
        per_page: parseInt(limit)
      },
      filters_applied: {
        business_name: business_name || null,
        analysis_type: analysis_type || null,
        date_from: date_from || null,
        date_to: date_to || null,
        search: search || null
      }
    });

  } catch (error) {
    console.error('Get audit trail history error:', error);
    res.status(500).send({ 
      message: 'Failed to retrieve audit trail history', 
      error: error.message 
    });
  }
});

// OPTIONAL: Get specific audit trail entry details
app.get('/api/audit-trail/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const auditEntry = await AuditTrail.findOne({
      _id: id,
      user_id: req.user.id
    }).populate('user_id', 'name email');

    if (!auditEntry) {
      return res.status(404).send({ message: 'Audit trail entry not found' });
    }

    res.status(200).send({
      id: auditEntry._id,
      business_name: auditEntry.business_name,
      
      // Complete survey data
      survey_data: auditEntry.survey_data,
      
      // Complete analysis data  
      analysis_data: auditEntry.analysis_data,
      
      // Save details
      save_details: auditEntry.save_details,
      
      // User info
      user: {
        name: auditEntry.user_id.name,
        email: auditEntry.user_id.email
      },
      
      // Timestamps
      created_at: auditEntry.created_at,
      analysis_generated_at: auditEntry.analysis_generated_at,
      saved_at: auditEntry.saved_at
    });

  } catch (error) {
    console.error('Get audit trail details error:', error);
    res.status(500).send({ 
      message: 'Failed to retrieve audit trail details', 
      error: error.message 
    });
  }
});

// ===============================
=======
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
// OPTIMIZED TRANSLATION ENDPOINTS
// ===============================

// Helper function for translation with caching and batching
const translateWithCache = (() => {
  const cache = new Map();
  const CACHE_EXPIRY = 3600000; // 1 hour in milliseconds
  
  return async (texts, targetLanguage) => {
    if (targetLanguage === 'en') {
      return texts;
    }

    const results = [];
    const textsToTranslate = [];
    const indices = [];

    // Check cache first
    texts.forEach((text, index) => {
      const cacheKey = `${text.trim()}_${targetLanguage}`;
      const cached = cache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        results[index] = cached.translation;
      } else if (text && text.trim()) {
        textsToTranslate.push(text.trim());
        indices.push(index);
      } else {
        results[index] = text;
      }
    });

    // If all texts were cached, return immediately
    if (textsToTranslate.length === 0) {
      return results;
    }

    // Batch translate uncached texts (chunks of 5 to respect rate limits)
    const BATCH_SIZE = 5;
    const axios = require('axios');
    
    for (let i = 0; i < textsToTranslate.length; i += BATCH_SIZE) {
      const batch = textsToTranslate.slice(i, i + BATCH_SIZE);
      const batchIndices = indices.slice(i, i + BATCH_SIZE);
      
      // Process batch concurrently with Promise.allSettled for better error handling
      const promises = batch.map(async (text) => {
        try {
          const response = await axios.get('https://api.mymemory.translated.net/get', {
            params: {
              q: text,
              langpair: `en|${targetLanguage}`,
              de: 'admin@traxxia.com'
            },
            timeout: 8000
          });
          
          if (response.data?.responseData?.translatedText) {
            return response.data.responseData.translatedText;
          }
          return text; // Fallback
        } catch (error) {
          console.error(`Translation error for "${text}":`, error.message);
          return text; // Fallback
        }
      });

      const batchResults = await Promise.allSettled(promises);
      
      // Store results and cache them
      batchResults.forEach((result, batchIndex) => {
        const originalIndex = batchIndices[batchIndex];
        const originalText = textsToTranslate[i + batchIndex];
        const translation = result.status === 'fulfilled' ? result.value : originalText;
        
        results[originalIndex] = translation;
        
        // Cache the translation
        const cacheKey = `${originalText}_${targetLanguage}`;
        cache.set(cacheKey, {
          translation,
          timestamp: Date.now()
        });
      });

      // Small delay between batches to respect rate limits
      if (i + BATCH_SIZE < textsToTranslate.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return results;
  };
})();

// Helper function to format response data (same as get-user-response)
// Fixed Helper function to format response data (same as get-user-response)
function formatResponseData(user, response, version, questionSet = null) {
  if (!response) {
    // Format for non-submitted response
    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        company: user.company || ''
      },
      survey: {
        version: version,
        submitted_at: null,
        total_questions: questionSet ? questionSet.questions.reduce((sum, cat) => sum + cat.questions.length, 0) : 0,
        total_answered: 0,
        status: 'not_submitted'
      },
      categories: questionSet ? questionSet.questions.map(category => ({
        category_id: category.id,
        category_name: category.name,
        questions_answered: 0,
        total_questions: category.questions.length,
        questions: category.questions.map(question => ({
          question_id: question.id,
          question_text: question.question,
          question_type: question.type,
          options: question.options || null,
          nested: question.nested || null,
<<<<<<< HEAD
          severity: question.severity || 'mandatory', // NEW FIELD
          phase: question.phase || 'initial',         // NEW FIELD
=======
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
          user_answer: null,
          answered: false
        }))
      })) : [],
      message: 'User has not submitted a survey response for this version yet'
    };
  }

<<<<<<< HEAD
  // Format for submitted response - UPDATED VERSION
=======
  // Format for submitted response - FIXED VERSION
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
  return {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      company: user.company || ''
    },
    survey: {
      version: response.question_set_version,
      submitted_at: response.submitted_at,
      total_questions: response.questions.reduce((sum, cat) => sum + cat.questions.length, 0),
      total_answered: response.answers.length,
      status: 'submitted'
    },
    categories: response.questions.map(category => {
      const categoryAnswers = response.answers.filter(answer => 
        category.questions.some(q => q.id === answer.question_id)
      );

      return {
        category_id: category.id,
        category_name: category.name,
        questions_answered: categoryAnswers.length,
        total_questions: category.questions.length,
        questions: category.questions.map(question => {
          const userAnswer = response.answers.find(ans => ans.question_id === question.id);
          
          return {
            question_id: question.id,
            question_text: question.question,
            question_type: question.type,
            options: question.options || null,
            nested: question.nested || null,
<<<<<<< HEAD
            severity: question.severity || 'mandatory', // NEW FIELD
            phase: question.phase || 'initial',         // NEW FIELD
=======
            // FIXED: This should match the original get-user-response format exactly
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
            user_answer: userAnswer ? {
              answer: userAnswer.answer || null,
              selected_option: userAnswer.selected_option || null,
              selected_options: userAnswer.selected_options || null,
              rating: userAnswer.rating || null
            } : null,
            answered: !!userAnswer
          };
        })
      };
    })
  };
}

<<<<<<< HEAD
app.get('/api/admin/question-statistics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { version } = req.query;
    
    let query = {};
    if (version) {
      query.version = version;
    }
    
    const questionSets = await CurrentQuestions.find(query).sort({ updated_at: -1 });
    
    if (questionSets.length === 0) {
      return res.status(404).send({ message: 'No question sets found' });
    }
    
    const statistics = questionSets.map(questionSet => {
      const stats = {
        version: questionSet.version,
        updated_at: questionSet.updated_at,
        totalCategories: questionSet.questions.length,
        totalQuestions: 0,
        severityBreakdown: {
          mandatory: 0,
          optional: 0
        },
        phaseBreakdown: {
          initial: 0,
          essential: 0,
          good: 0,
          excellent: 0
        },
        detailedBreakdown: {
          mandatory_by_phase: { initial: 0, essential: 0, good: 0, excellent: 0 },
          optional_by_phase: { initial: 0, essential: 0, good: 0, excellent: 0 }
        }
      };
      
      questionSet.questions.forEach(category => {
        if (category.questions) {
          category.questions.forEach(question => {
            stats.totalQuestions++;
            
            const severity = question.severity || 'mandatory';
            const phase = question.phase || 'initial';
            
            stats.severityBreakdown[severity]++;
            stats.phaseBreakdown[phase]++;
            stats.detailedBreakdown[`${severity}_by_phase`][phase]++;
          });
        }
      });
      
      return stats;
    });
    
    res.status(200).send({
      statistics: version ? statistics[0] : statistics,
      total_versions: questionSets.length
    });
    
  } catch (error) {
    console.error('Get question statistics error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// UPDATE 4: New endpoint to filter questions by severity and phase
app.post('/api/questions/filtered', authenticateToken, async (req, res) => {
  try {
    const { 
      version, 
      severity,  // 'mandatory', 'optional', or null for all
      phase,     // 'initial', 'essential', 'good', 'excellent', or null for all
      category_ids // Array of category IDs to filter by
    } = req.body;
    
    // Get question set (specific version or latest)
    let questionSet;
    if (version) {
      questionSet = await CurrentQuestions.findOne({ version });
    } else {
      questionSet = await CurrentQuestions.findOne().sort({ updated_at: -1 });
    }
    
    if (!questionSet) {
      return res.status(404).send({ message: 'Question set not found' });
    }
    
    // Filter questions based on criteria
    const filteredCategories = questionSet.questions
      .filter(category => {
        // Filter by category IDs if provided
        if (category_ids && category_ids.length > 0) {
          return category_ids.includes(category.id);
        }
        return true;
      })
      .map(category => ({
        ...category,
        questions: category.questions ? category.questions.filter(question => {
          // Filter by severity
          if (severity && question.severity !== severity) {
            return false;
          }
          
          // Filter by phase
          if (phase && question.phase !== phase) {
            return false;
          }
          
          return true;
        }) : []
      }))
      .filter(category => category.questions.length > 0); // Remove empty categories
    
    const filteredStats = {
      total_categories: filteredCategories.length,
      total_questions: filteredCategories.reduce((sum, cat) => sum + cat.questions.length, 0),
      applied_filters: {
        version: version || 'latest',
        severity: severity || 'all',
        phase: phase || 'all',
        category_ids: category_ids || 'all'
      }
    };
    
    res.status(200).send({
      questions: filteredCategories,
      version: questionSet.version,
      statistics: filteredStats
    });
    
  } catch (error) {
    console.error('Get filtered questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

=======
>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
// OPTIMIZED: Single translation endpoint with consistent response format
app.post('/api/get-user-response-translated', authenticateToken, async (req, res) => {
  try {
    const { user_id, version, language = 'en' } = req.body;

    if (!user_id || !version) {
      return res.status(400).send({ message: 'User ID and version are required' });
    }

    // Get user and response data (same logic as original get-user-response)
    const user = await User.findById(user_id).select('name email company');
    if (!user) {
      return res.status(404).send({ message: `User with ID '${user_id}' not found` });
    }

    const response = await SurveyResponse.findOne({ 
      user_id: user_id,
      question_set_version: version
    });

    let responseData;

    // Build response data exactly like the original get-user-response endpoint
    if (!response) {
      // Get the question set for this version to show available questions
      const questionSet = await CurrentQuestions.findOne({ version });
      
      responseData = {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          company: user.company || ''
        },
        survey: {
          version: version,
          submitted_at: null,
          total_questions: questionSet ? questionSet.questions.reduce((sum, cat) => sum + cat.questions.length, 0) : 0,
          total_answered: 0,
          status: 'not_submitted'
        },
        categories: questionSet ? questionSet.questions.map(category => ({
          category_id: category.id,
          category_name: category.name,
          questions_answered: 0,
          total_questions: category.questions.length,
          questions: category.questions.map(question => ({
            question_id: question.id,
            question_text: question.question,
            question_type: question.type,
            options: question.options || null,
            nested: question.nested || null,
            user_answer: null,
            answered: false
          }))
        })) : [],
        message: 'User has not submitted a survey response for this version yet'
      };
    } else {
      // Format the response data exactly like the original endpoint
      responseData = {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          company: user.company || ''
        },
        survey: {
          version: response.question_set_version,
          submitted_at: response.submitted_at,
          total_questions: response.questions.reduce((sum, cat) => sum + cat.questions.length, 0),
          total_answered: response.answers.length,
          status: 'submitted'
        },
        categories: response.questions.map(category => {
          const categoryAnswers = response.answers.filter(answer => 
            category.questions.some(q => q.id === answer.question_id)
          );

          return {
            category_id: category.id,
            category_name: category.name,
            questions_answered: categoryAnswers.length,
            total_questions: category.questions.length,
            questions: category.questions.map(question => {
              const userAnswer = response.answers.find(ans => ans.question_id === question.id);
              
              return {
                question_id: question.id,
                question_text: question.question,
                question_type: question.type,
                options: question.options || null,
                nested: question.nested || null,
                user_answer: userAnswer ? {
                  answer: userAnswer.answer || null,
                  selected_option: userAnswer.selected_option || null,
                  selected_options: userAnswer.selected_options || null,
                  rating: userAnswer.rating || null
                } : null,
                answered: !!userAnswer
              };
            })
          };
        })
      };
    }

    // If language is English, return as-is
    if (language === 'en') {
      return res.status(200).send({
        ...responseData,
        translated: false,
        target_language: language
      });
    }

    // Collect all texts that need translation
    const textsToTranslate = [];
    const textMappings = [];

    responseData.categories.forEach((category, categoryIndex) => {
      // Category name
      if (category.category_name) {
        textsToTranslate.push(category.category_name);
        textMappings.push({ type: 'category_name', categoryIndex });
      }

      // Questions
      category.questions?.forEach((question, questionIndex) => {
        // Main question
        if (question.question_text) {
          textsToTranslate.push(question.question_text);
          textMappings.push({ type: 'question_text', categoryIndex, questionIndex });
        }

        // Nested question
        if (question.nested?.question) {
          textsToTranslate.push(question.nested.question);
          textMappings.push({ type: 'nested_question', categoryIndex, questionIndex });
        }

        // Options
        if (question.options && Array.isArray(question.options)) {
          question.options.forEach((option, optionIndex) => {
            if (option) {
              textsToTranslate.push(option);
              textMappings.push({ type: 'option', categoryIndex, questionIndex, optionIndex });
            }
          });
        }
      });
    });

    console.log(`Starting optimized translation for ${textsToTranslate.length} texts to ${language}`);
    const startTime = Date.now();

    // Translate all texts using optimized function
    const translatedTexts = await translateWithCache(textsToTranslate, language);

    console.log(`Translation completed in ${Date.now() - startTime}ms`);

    // Apply translations back to data structure
    const translatedData = JSON.parse(JSON.stringify(responseData));
    
    translatedTexts.forEach((translatedText, index) => {
      const mapping = textMappings[index];
      
      switch (mapping.type) {
        case 'category_name':
          translatedData.categories[mapping.categoryIndex].category_name = translatedText;
          break;
        case 'question_text':
          translatedData.categories[mapping.categoryIndex].questions[mapping.questionIndex].question_text = translatedText;
          break;
        case 'nested_question':
          translatedData.categories[mapping.categoryIndex].questions[mapping.questionIndex].nested.question = translatedText;
          break;
        case 'option':
          translatedData.categories[mapping.categoryIndex].questions[mapping.questionIndex].options[mapping.optionIndex] = translatedText;
          break;
      }
    });

    res.status(200).send({
      ...translatedData,
      translated: true,
      target_language: language,
      translation_time_ms: Date.now() - startTime
    });

  } catch (error) {
    console.error('Get user response with translation error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Clear translation cache endpoint (admin only)
app.post('/api/admin/clear-translation-cache', authenticateToken, requireAdmin, (req, res) => {
  try {
    res.status(200).send({ 
      message: 'Translation cache cleared. Note: Cache will be fully cleared on server restart.' 
    });
  } catch (error) {
    res.status(500).send({ message: 'Failed to clear cache', error: error.message });
  }
});

// Simple translation endpoint for testing
app.post('/api/translate', authenticateToken, async (req, res) => {
  try {
    const { text, targetLanguage = 'es' } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const translatedTexts = await translateWithCache([text], targetLanguage);
    
    res.json({ 
      translatedText: translatedTexts[0],
      cached: false
    });
    
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ 
      error: 'Translation failed', 
      translatedText: req.body.text
    });
  }
});

// ===============================
// 5. USER RESPONSE RETRIEVAL
// ===============================

app.post('/api/get-user-response', authenticateToken, async (req, res) => {
  try {
    const { user_id, version } = req.body;

    if (!user_id) {
      return res.status(400).send({ message: 'User ID is required' });
    }

    if (!version) {
      return res.status(400).send({ message: 'Version is required' });
    }

    // Find user by ID
    const user = await User.findById(user_id).select('name email company');

    if (!user) {
      return res.status(404).send({ message: `User with ID '${user_id}' not found` });
    }

    // Get user's survey response for the specified version
    const response = await SurveyResponse.findOne({ 
      user_id: user_id,
      question_set_version: version
    });

    // If no response found, return user info with empty survey data
    if (!response) {
      // Get the question set for this version to show available questions
      const questionSet = await CurrentQuestions.findOne({ version });
      
      return res.status(200).send({
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          company: user.company || ''
        },
        survey: {
          version: version,
          submitted_at: null,
          total_questions: questionSet ? questionSet.questions.reduce((sum, cat) => sum + cat.questions.length, 0) : 0,
          total_answered: 0,
          status: 'not_submitted'
        },
        categories: questionSet ? questionSet.questions.map(category => ({
          category_id: category.id,
          category_name: category.name,
          questions_answered: 0,
          total_questions: category.questions.length,
          questions: category.questions.map(question => ({
            question_id: question.id,
            question_text: question.question,
            question_type: question.type,
            options: question.options || null,
            nested: question.nested || null,
            user_answer: null,
            answered: false
          }))
        })) : [],
        message: 'User has not submitted a survey response for this version yet'
      });
    }

    // Format the response data (existing code for when response exists)
    const formattedResponse = {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        company: user.company || ''
      },
      survey: {
        version: response.question_set_version,
        submitted_at: response.submitted_at,
        total_questions: response.questions.reduce((sum, cat) => sum + cat.questions.length, 0),
        total_answered: response.answers.length,
        status: 'submitted'
      },
      categories: response.questions.map(category => {
        const categoryAnswers = response.answers.filter(answer => 
          category.questions.some(q => q.id === answer.question_id)
        );

        return {
          category_id: category.id,
          category_name: category.name,
          questions_answered: categoryAnswers.length,
          total_questions: category.questions.length,
          questions: category.questions.map(question => {
            const userAnswer = response.answers.find(ans => ans.question_id === question.id);
            
            return {
              question_id: question.id,
              question_text: question.question,
              question_type: question.type,
              options: question.options || null,
              nested: question.nested || null,
              user_answer: userAnswer ? {
                answer: userAnswer.answer || null,
                selected_option: userAnswer.selected_option || null,
                selected_options: userAnswer.selected_options || null,
                rating: userAnswer.rating || null
              } : null,
              answered: !!userAnswer
            };
          })
        };
      })
    };

    res.status(200).send(formattedResponse);

  } catch (error) {
    console.error('Get user response error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// 6. CSV DOWNLOAD API
// ===============================

app.get('/api/download-csv/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { version } = req.query; // Version parameter required

    if (!version) {
      return res.status(400).send({ message: 'Version parameter is required' });
    }

    const user = await User.findById(userId).select('name email company');
    if (!user) {
      return res.status(404).send({ message: 'User not found' });
    }

    const response = await SurveyResponse.findOne({ 
      user_id: userId,
      question_set_version: version
    });

    if (!response) {
      return res.status(404).send({ 
        message: `No survey response found for user in version ${version}` 
      });
    }

    // Prepare CSV data
    const csvData = [];

    // User info
    csvData.push({
      'Section': 'User Information',
      'Question': 'Name',
      'Answer': user.name
    });
    csvData.push({
      'Section': 'User Information',
      'Question': 'Email',
      'Answer': user.email
    });

    csvData.push({ 'Section': '', 'Question': '', 'Answer': '' });

    // Questions and answers
    response.questions.forEach((category) => {
      category.questions.forEach((question) => {
        const answer = response.answers.find(ans => ans.question_id === question.id);
        
        csvData.push({
          'Section': category.name,
          'Question': question.question,
          'Answer': answer ? (answer.answer || answer.selected_option || answer.rating || '') : 'No Answer'
        });
      });
    });

    const csv = convertToCSV(csvData);
    const filename = `survey-response-${user.name.replace(/\s+/g, '-')}-v${version}-${Date.now()}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);

  } catch (error) {
    console.error('Download CSV error:', error);
    res.status(500).send({ message: 'Download failed', error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
<<<<<<< HEAD
  res.status(200).send('Traxxia Survey Backend with Audit Trail is running 🚀');
});

// NEW: Console log showing new audit trail endpoints
console.log('🎯 Audit Trail APIs loaded successfully!');
console.log('📊 New endpoints available:');


=======
  res.status(200).send('Traxxia Survey Backend with JWT is running 🚀');
});

>>>>>>> 4fea36c8a6e5b94aadc1405b0639359da9ada375
app.listen(port, '0.0.0.0', () => console.log(`🚀 Traxxia Survey Backend running on port ${port}`));