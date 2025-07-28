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
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_survey';
let db;

async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();
    console.log('✅ Connected to MongoDB');
    
    // Create indexes for better performance
    try {
      await db.collection('conversations').createIndex({ user_id: 1, status: 1 });
      await db.collection('conversations').createIndex({ user_id: 1, session_id: 1 });
      await db.collection('users').createIndex({ email: 1 }, { unique: true });
      await db.collection('questions').createIndex({ id: 1 }, { unique: true });
      console.log('✅ Database indexes created');
    } catch (indexError) {
      console.log('ℹ️ Some indexes may already exist');
    }
    
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

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
  const answeredCount = Object.keys(finalAnswers).length;
  const mandatoryQuestions = allQuestions.filter(q => q.severity === 'mandatory');
  const mandatoryAnswered = Object.values(finalAnswers).filter(a => a.severity === 'mandatory').length;

  return {
    totalQuestions: allQuestions.length,
    answeredQuestions: answeredCount,
    mandatoryAnswered: mandatoryAnswered,
    mandatoryTotal: mandatoryQuestions.length,
    percentage: mandatoryQuestions.length > 0 ? Math.round((mandatoryAnswered / mandatoryQuestions.length) * 100) : 0
  };
};

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
// AUTHENTICATION ENDPOINTS
// ===============================

// User Registration
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).send({ message: 'Name, email, and password are required' });
    }

    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).send({ message: 'User already exists with this email' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = {
      name,
      email,
      password: hashedPassword,
      role: 'user',
      created_at: new Date()
    };

    const result = await db.collection('users').insertOne(newUser);

    res.status(201).send({
      message: 'User created successfully',
      user: {
        id: result.insertedId,
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

    const user = await db.collection('users').findOne({ email });
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
    const questions = await db.collection('questions')
      .find({})
      .project({ id: 1, question: 1, severity: 1, phase: 1 })
      .sort({ id: 1 })
      .toArray();

    res.status(200).send({ questions });

  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// POST: Add Questions (Admin only - for initial setup)
app.post('/api/questions', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).send({ message: 'Admin access required' });
    }

    const { questions } = req.body;
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).send({ message: 'Questions array is required' });
    }

    // Add timestamps to questions
    const questionsWithTimestamp = questions.map(q => ({
      ...q,
      created_at: new Date()
    }));

    // Clear existing questions and insert new ones
    await db.collection('questions').deleteMany({});
    const result = await db.collection('questions').insertMany(questionsWithTimestamp);

    res.status(201).send({
      message: `Successfully added ${result.insertedCount} questions`,
      questions: questionsWithTimestamp
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

    const userId = new ObjectId(req.user.id);

    // Find or create conversation
    let conversation = null;
    
    if (sessionId) {
      conversation = await db.collection('conversations').findOne({
        user_id: userId,
        session_id: sessionId,
        status: 'active'
      });
    }

    if (!conversation) {
      conversation = await db.collection('conversations').findOne({
        user_id: userId,
        status: 'active'
      });
    }

    if (!conversation) {
      const allQuestions = await db.collection('questions').find({}).sort({ id: 1 }).toArray();
      
      const newSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      conversation = {
        user_id: userId,
        session_id: newSessionId,
        messages: [],
        finalAnswers: {},
        progress: {
          totalQuestions: allQuestions.length,
          answeredQuestions: 0,
          mandatoryAnswered: 0,
          mandatoryTotal: allQuestions.filter(q => q.severity === 'mandatory').length,
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
        },
        analyses: [],
        status: 'active',
        startedAt: new Date(),
        lastActivity: new Date()
      };

      const result = await db.collection('conversations').insertOne(conversation);
      conversation._id = result.insertedId;
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

    await db.collection('conversations').updateOne(
      { _id: conversation._id },
      {
        $push: { messages: messageData },
        $set: { lastActivity: new Date() }
      }
    );

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

    const userId = new ObjectId(req.user.id);

    const conversation = await db.collection('conversations').findOne({
      user_id: userId,
      session_id: sessionId,
      status: 'active'
    });

    if (!conversation) {
      return res.status(404).send({ message: 'Conversation not found' });
    }

    // Get question details
    const question = await db.collection('questions').findOne({ id: questionId });
    if (!question) {
      return res.status(404).send({ message: 'Question not found' });
    }

    // Prepare final answer
    const finalAnswerData = {
      questionId: question.id,
      questionText: question.question,
      finalAnswer: finalAnswer,
      phase: question.phase,
      severity: question.severity,
      attemptCount: attemptCount,
      completedAt: new Date()
    };

    // Update conversation with final answer and business data
    const updatedBusinessData = { ...conversation.businessData };
    updateBusinessData({ businessData: updatedBusinessData }, questionId, finalAnswer);

    // Calculate progress
    const updatedFinalAnswers = { ...conversation.finalAnswers };
    updatedFinalAnswers[questionId.toString()] = finalAnswerData;

    const allQuestions = await db.collection('questions').find({}).sort({ id: 1 }).toArray();
    const progressData = calculateProgress(updatedFinalAnswers, allQuestions);

    await db.collection('conversations').updateOne(
      { _id: conversation._id },
      {
        $set: {
          [`finalAnswers.${questionId}`]: finalAnswerData,
          businessData: updatedBusinessData,
          'progress.totalQuestions': progressData.totalQuestions,
          'progress.answeredQuestions': progressData.answeredQuestions,
          'progress.mandatoryAnswered': progressData.mandatoryAnswered,
          'progress.mandatoryTotal': progressData.mandatoryTotal,
          'progress.percentage': progressData.percentage,
          lastActivity: new Date()
        }
      }
    );

    res.status(200).send({
      message: 'Answer finalized successfully',
      progress: {
        ...conversation.progress,
        ...progressData
      },
      businessData: updatedBusinessData
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
    const userId = new ObjectId(req.user.id);

    const conversation = await db.collection('conversations').findOne({
      user_id: userId,
      session_id: sessionId,
      status: 'active'
    });

    if (!conversation) {
      return res.status(404).send({ message: 'Conversation not found' });
    }

    const completedPhases = conversation.progress.completedPhases || [];
    if (!completedPhases.includes(phase)) {
      completedPhases.push(phase);
    }

    await db.collection('conversations').updateOne(
      { _id: conversation._id },
      {
        $set: {
          'progress.completedPhases': completedPhases,
          'progress.currentPhase': phase,
          lastActivity: new Date()
        }
      }
    );

    res.status(200).send({
      message: `Phase ${phase} completed successfully`,
      completedPhases: completedPhases
    });

  } catch (error) {
    console.error('Complete phase error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// GET: Get current conversation
app.get('/api/conversation/current', authenticateToken, async (req, res) => {
  try {
    const userId = new ObjectId(req.user.id);

    const conversation = await db.collection('conversations').findOne(
      { user_id: userId, status: 'active' },
      { sort: { lastActivity: -1 } }
    );

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

    res.status(200).send({
      sessionId: conversation.session_id,
      messages: conversation.messages || [],
      finalAnswers: conversation.finalAnswers || {},
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
    message: 'Native MongoDB API is running 🚀',
    timestamp: new Date().toISOString(),
    database: db ? 'Connected' : 'Disconnected',
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

// ===============================
// START SERVER
// ===============================

// Connect to MongoDB first, then start server
connectToMongoDB().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Native MongoDB API Server running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});