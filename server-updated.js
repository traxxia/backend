const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
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

// ===============================
// SCHEMAS
// ===============================

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
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Questions Schema
const questionSchema = new mongoose.Schema({
  id: {
    type: Number,
    required: true,
    unique: true
  },
  question: {
    type: String,
    required: true
  },
  severity: {
    type: String,
    enum: ['mandatory', 'optional'],
    required: true
  },
  phase: {
    type: String,
    enum: ['initial', 'essential', 'good', 'excellent'],
    required: true
  },
  created_at: { type: Date, default: Date.now }
});

const Question = mongoose.model('Question', questionSchema);

// Conversation Schema - Stores all Q&A interactions including follow-ups
const conversationSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  session_id: {
    type: String,
    required: true,
    default: () => `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  // Store the complete conversation flow
  messages: [{
    id: { type: String, required: true },
    type: { type: String, enum: ['user', 'bot'], required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    
    // Question metadata (for bot messages)
    questionId: { type: Number },
    phase: { type: String, enum: ['initial', 'essential', 'good', 'excellent'] },
    severity: { type: String, enum: ['mandatory', 'optional'] },
    isFollowUp: { type: Boolean, default: false },
    isPhaseValidation: { type: Boolean, default: false },
    
    // ML validation metadata
    mlValidation: {
      validated: { type: Boolean, default: false },
      valid: { type: Boolean },
      feedback: { type: String },
      attempt: { type: Number, default: 1 }
    }
  }],
  
  // Final answers after validation (clean data for analysis)
  finalAnswers: {
    type: Map,
    of: {
      questionId: { type: Number, required: true },
      questionText: { type: String, required: true },
      finalAnswer: { type: String, required: true }, // Combined answer after follow-ups
      phase: { type: String, required: true },
      severity: { type: String, required: true },
      attemptCount: { type: Number, default: 1 }, // How many follow-ups were needed
      completedAt: { type: Date, default: Date.now }
    }
  },
  
  // Progress tracking
  progress: {
    totalQuestions: { type: Number, default: 0 },
    answeredQuestions: { type: Number, default: 0 },
    mandatoryAnswered: { type: Number, default: 0 },
    mandatoryTotal: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    currentPhase: {
      type: String,
      enum: ['initial', 'essential', 'good', 'excellent'],
      default: 'initial'
    },
    completedPhases: [String]
  },
  
  // Business data extracted from answers
  businessData: {
    name: { type: String, default: 'Your Business' },
    description: { type: String, default: '' },
    industry: { type: String, default: '' },
    targetAudience: { type: String, default: '' },
    products: { type: String, default: '' }
  },
  
  // Future: Analysis results will be stored here
  analyses: [{
    type: { type: String, enum: ['swot', 'strategic', 'financial', 'competitive'] },
    result: { type: String },
    generatedAt: { type: Date, default: Date.now },
    model: { type: String, default: 'groq' },
    tokensUsed: { type: Number, default: 0 }
  }],
  
  status: {
    type: String,
    enum: ['active', 'completed', 'paused'],
    default: 'active'
  },
  
  // Timestamps
  startedAt: { type: Date, default: Date.now },
  lastActivity: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

// Indexes for performance
conversationSchema.index({ user_id: 1, status: 1 });
conversationSchema.index({ user_id: 1, session_id: 1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

// ===============================
// MIDDLEWARE
// ===============================

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

// ===============================
// HELPER FUNCTIONS
// ===============================

// Extract business name from text
const extractBusinessName = (text) => {
  const patterns = [
    /(?:we are|i am|this is|called|business is|company is)\s+([A-Z][a-zA-Z\s&.-]+?)(?:\.|,|$)/i,
    /^([A-Z][a-zA-Z\s&.-]+?)\s+(?:is|provides|offers|teaches)/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] && match[1].length <= 50) {
      return match[1].trim();
    }
  }
  return null;
};

// Update business data based on answers
const updateBusinessData = (conversation, questionId, answer) => {
  if (questionId === 1) {
    const businessName = extractBusinessName(answer);
    if (businessName) conversation.businessData.name = businessName;
    conversation.businessData.description = answer;
  } else if (questionId === 2) {
    conversation.businessData.industry = answer;
  } else if (questionId === 3) {
    conversation.businessData.targetAudience = answer;
  } else if (questionId === 4) {
    conversation.businessData.products = answer;
  }
};

// Calculate progress
const calculateProgress = (finalAnswers, allQuestions) => {
  const answeredCount = finalAnswers.size;
  const mandatoryQuestions = allQuestions.filter(q => q.severity === 'mandatory');
  const mandatoryAnswered = Array.from(finalAnswers.values()).filter(a => a.severity === 'mandatory').length;

  return {
    totalQuestions: allQuestions.length,
    answeredQuestions: answeredCount,
    mandatoryAnswered: mandatoryAnswered,
    mandatoryTotal: mandatoryQuestions.length,
    percentage: mandatoryQuestions.length > 0 ? Math.round((mandatoryAnswered / mandatoryQuestions.length) * 100) : 0
  };
};

// ===============================
// AUTHENTICATION ENDPOINTS
// ===============================

// User Registration
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).send({ message: 'Name, email, and password are required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).send({ message: 'User already exists with this email' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      role: 'user'
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

// User Login
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

    const token = jwt.sign({
      id: user._id,
      email: user.email,
      role: user.role
    }, secretKey, { expiresIn: '24h' });

    res.status(200).send({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// QUESTIONS ENDPOINTS
// ===============================

// GET: Retrieve All Questions
app.get('/api/questions', authenticateToken, async (req, res) => {
  try {
    const questions = await Question.find({})
      .select('id question severity phase')
      .sort({ id: 1 });

    res.status(200).send({
      questions: questions
    });

  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// POST: Add Questions (Admin only - for initial setup)
app.post('/api/questions', authenticateToken, async (req, res) => {
  try {
    // Simple admin check
    if (req.user.role !== 'admin') {
      return res.status(403).send({ message: 'Admin access required' });
    }

    const { questions } = req.body;
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).send({ message: 'Questions array is required' });
    }

    // Clear existing questions and insert new ones
    await Question.deleteMany({});
    const savedQuestions = await Question.insertMany(questions);

    res.status(201).send({
      message: `Successfully added ${savedQuestions.length} questions`,
      questions: savedQuestions
    });

  } catch (error) {
    console.error('Add questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// CONVERSATION ENDPOINTS (Auto-Save)
// ===============================

// POST: Auto-save message (Bot or User)
app.post('/api/conversation/save-message', authenticateToken, async (req, res) => {
  try {
    const {
      sessionId,
      message: {
        id,
        type,
        text,
        questionId,
        phase,
        severity,
        isFollowUp = false,
        isPhaseValidation = false,
        mlValidation = {}
      }
    } = req.body;

    const userId = req.user.id;

    // Find or create conversation
    let conversation = null;
    
    // If sessionId is provided, try to find existing conversation
    if (sessionId) {
      conversation = await Conversation.findOne({
        user_id: userId,
        session_id: sessionId,
        status: 'active'
      });
    }

    // If no conversation found (sessionId null or not found), find any active conversation
    if (!conversation) {
      conversation = await Conversation.findOne({
        user_id: userId,
        status: 'active'
      });
    }

    // If still no conversation, create new one
    if (!conversation) {
      const allQuestions = await Question.find({}).sort({ id: 1 });
      
      // Generate new sessionId if not provided
      const newSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      conversation = new Conversation({
        user_id: userId,
        session_id: newSessionId,
        messages: [],
        finalAnswers: new Map(),
        progress: {
          totalQuestions: allQuestions.length,
          mandatoryTotal: allQuestions.filter(q => q.severity === 'mandatory').length
        }
      });
    }

    // Add message to conversation
    const messageData = {
      id: id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      text,
      timestamp: new Date()
    };

    if (type === 'bot') {
      messageData.questionId = questionId;
      messageData.phase = phase;
      messageData.severity = severity;
      messageData.isFollowUp = isFollowUp;
      messageData.isPhaseValidation = isPhaseValidation;
    }

    if (mlValidation && Object.keys(mlValidation).length > 0) {
      messageData.mlValidation = mlValidation;
    }

    conversation.messages.push(messageData);
    conversation.lastActivity = new Date();

    await conversation.save();

    console.log(`💾 Message saved to session: ${conversation.session_id}`);

    res.status(200).send({
      message: 'Message saved successfully',
      sessionId: conversation.session_id,
      messageId: messageData.id
    });

  } catch (error) {
    console.error('Save message error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// POST: Finalize answer (when ML validation passes)
app.post('/api/conversation/finalize-answer', authenticateToken, async (req, res) => {
  try {
    const {
      sessionId,
      questionId,
      finalAnswer,
      attemptCount = 1
    } = req.body;

    const userId = req.user.id;

    const conversation = await Conversation.findOne({
      user_id: userId,
      session_id: sessionId,
      status: 'active'
    });

    if (!conversation) {
      return res.status(404).send({ message: 'Conversation not found' });
    }

    // Get question details
    const question = await Question.findOne({ id: questionId });
    if (!question) {
      return res.status(404).send({ message: 'Question not found' });
    }

    // Store final answer
    conversation.finalAnswers.set(questionId.toString(), {
      questionId: question.id,
      questionText: question.question,
      finalAnswer: finalAnswer,
      phase: question.phase,
      severity: question.severity,
      attemptCount: attemptCount,
      completedAt: new Date()
    });

    // Update business data
    updateBusinessData(conversation, questionId, finalAnswer);

    // Recalculate progress
    const allQuestions = await Question.find({}).sort({ id: 1 });
    const progressData = calculateProgress(conversation.finalAnswers, allQuestions);
    
    conversation.progress.totalQuestions = progressData.totalQuestions;
    conversation.progress.answeredQuestions = progressData.answeredQuestions;
    conversation.progress.mandatoryAnswered = progressData.mandatoryAnswered;
    conversation.progress.mandatoryTotal = progressData.mandatoryTotal;
    conversation.progress.percentage = progressData.percentage;

    conversation.lastActivity = new Date();

    await conversation.save();

    res.status(200).send({
      message: 'Answer finalized successfully',
      progress: conversation.progress,
      businessData: conversation.businessData
    });

  } catch (error) {
    console.error('Finalize answer error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// POST: Complete phase
app.post('/api/conversation/complete-phase', authenticateToken, async (req, res) => {
  try {
    const { sessionId, phase } = req.body;
    const userId = req.user.id;

    const conversation = await Conversation.findOne({
      user_id: userId,
      session_id: sessionId,
      status: 'active'
    });

    if (!conversation) {
      return res.status(404).send({ message: 'Conversation not found' });
    }

    // Add to completed phases if not already there
    if (!conversation.progress.completedPhases.includes(phase)) {
      conversation.progress.completedPhases.push(phase);
    }

    conversation.progress.currentPhase = phase;
    conversation.lastActivity = new Date();

    await conversation.save();

    res.status(200).send({
      message: `Phase ${phase} completed successfully`,
      completedPhases: conversation.progress.completedPhases
    });

  } catch (error) {
    console.error('Complete phase error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// GET: Get current conversation
app.get('/api/conversation/current', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const conversation = await Conversation.findOne({
      user_id: userId,
      status: 'active'
    }).sort({ lastActivity: -1 });

    if (!conversation) {
      return res.status(200).send({
        sessionId: null,
        messages: [],
        finalAnswers: {},
        progress: {
          totalQuestions: 0,
          answeredQuestions: 0,
          mandatoryAnswered: 0,
          mandatoryTotal: 0,
          percentage: 0,
          currentPhase: 'initial',
          completedPhases: []
        },
        businessData: {
          name: 'Your Business',
          description: '',
          industry: '',
          targetAudience: '',
          products: ''
        }
      });
    }

    // Convert Map to Object for JSON response
    const finalAnswersObj = {};
    conversation.finalAnswers.forEach((value, key) => {
      finalAnswersObj[key] = value;
    });

    res.status(200).send({
      sessionId: conversation.session_id,
      messages: conversation.messages,
      finalAnswers: finalAnswersObj,
      progress: conversation.progress,
      businessData: conversation.businessData,
      lastActivity: conversation.lastActivity
    });

  } catch (error) {
    console.error('Get current conversation error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ===============================
// HEALTH CHECK
// ===============================

app.get('/health', (req, res) => {
  res.status(200).send({
    message: 'Streamlined Auto-Save API is running 🚀',
    timestamp: new Date().toISOString(),
    endpoints: {
      authentication: [
        'POST /api/users (register)',
        'POST /api/login'
      ],
      questions: [
        'GET /api/questions',
        'POST /api/questions (admin only)'
      ],
      conversation: [
        'POST /api/conversation/save-message',
        'POST /api/conversation/finalize-answer',
        'POST /api/conversation/complete-phase',
        'GET /api/conversation/current'
      ]
    }
  });
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Streamlined Auto-Save API Server running on port ${port}`);
});