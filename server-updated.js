const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Groq } = require('groq-sdk'); // Add this import
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;
const secretKey = process.env.SECRET_KEY || 'default_secret_key';

app.use(bodyParser.json());
app.use(cors());

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY // Add this to your .env file
});

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

// User Schema (same as before for authentication)
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
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const Question = mongoose.model('Question', questionSchema);

// User Answers Schema
const userAnswersSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  session_id: {
    type: String,
    required: true
  },
  version: {
    type: String,
    default: '1.0'
  },
  status: {
    type: String,
    enum: ['in_progress', 'completed'],
    default: 'in_progress'
  },
  // Store answers as an object with questionId as key
  answers: {
    type: Map,
    of: {
      question_id: { type: Number, required: true },
      question_text: { type: String, required: true },
      answer: { type: String, required: true },
      phase: {
        type: String,
        enum: ['initial', 'essential', 'good', 'excellent'],
        required: true
      },
      severity: {
        type: String,
        enum: ['mandatory', 'optional'],
        required: true
      },
      answered_at: { type: Date, default: Date.now }
    },
    default: {}
  },
  // Progress tracking
  progress: {
    total_questions: { type: Number, default: 0 },
    answered_questions: { type: Number, default: 0 },
    mandatory_answered: { type: Number, default: 0 },
    mandatory_total: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    current_phase: {
      type: String,
      enum: ['initial', 'essential', 'good', 'excellent'],
      default: 'initial'
    },
    phases_completed: [{
      phase: String,
      completed_at: Date
    }]
  },
  // Timestamps
  started_at: { type: Date, default: Date.now },
  completed_at: { type: Date },
  last_updated: { type: Date, default: Date.now }
});

// Index for efficient queries
userAnswersSchema.index({ user_id: 1, status: 1 });
userAnswersSchema.index({ user_id: 1, session_id: 1 });

const UserAnswers = mongoose.model('UserAnswers', userAnswersSchema);

// NEW: Analysis Schema to store generated analyses
const analysisSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  session_id: {
    type: String,
    required: true
  },
  analysis_type: {
    type: String,
    enum: ['swot', 'financial', 'strategic', 'competitive'],
    required: true
  },
  business_data: {
    name: String,
    description: String,
    industry: String,
    target_audience: String,
    products: String
  },
  questions_used: [{
    question_id: Number,
    question_text: String,
    answer: String,
    phase: String,
    severity: String
  }],
  analysis_result: {
    type: String,
    required: true
  },
  model_used: {
    type: String,
    default: 'groq'
  },
  tokens_used: Number,
  generated_at: { type: Date, default: Date.now }
});

const Analysis = mongoose.model('Analysis', analysisSchema);

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

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send({ message: 'Admin access required' });
  }
  next();
};

// ===============================
// HELPER FUNCTIONS
// ===============================

// Generate session ID
const generateSessionId = () => {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Calculate progress
const calculateProgress = (answers, allQuestions) => {
  const answeredCount = Object.keys(answers).length;
  const mandatoryQuestions = allQuestions.filter(q => q.severity === 'mandatory');
  const mandatoryAnswered = Object.values(answers).filter(a => a.severity === 'mandatory').length;

  return {
    total_questions: allQuestions.length,
    answered_questions: answeredCount,
    mandatory_answered: mandatoryAnswered,
    mandatory_total: mandatoryQuestions.length,
    percentage: mandatoryQuestions.length > 0 ? Math.round((mandatoryAnswered / mandatoryQuestions.length) * 100) : 0
  };
};

// Check if phase is completed
const checkPhaseCompletion = (answers, phase, allQuestions) => {
  const phaseQuestions = allQuestions.filter(q => q.phase === phase);
  const mandatoryPhaseQuestions = phaseQuestions.filter(q => q.severity === 'mandatory');
  const answeredMandatory = Object.values(answers).filter(a =>
    a.phase === phase && a.severity === 'mandatory'
  );

  return answeredMandatory.length >= mandatoryPhaseQuestions.length;
};

// ===============================
// GROQ ANALYSIS FUNCTIONS
// ===============================

// Function to generate analysis using Groq
async function generateAnalysisWithGroq(businessData, questions, analysisType) {
  try {
    const prompt = buildAnalysisPrompt(businessData, questions, analysisType);

    console.log(`🤖 Generating ${analysisType} analysis for: ${businessData.name}`);

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a strategic business analyst expert with years of experience in business consulting. Provide comprehensive, actionable business analysis based on the information provided. Format your response in clear markdown with proper headings and bullet points. Be specific and provide actionable insights."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: "llama3-70b-8192", // Use the larger model for better analysis
      temperature: 0.7,
      max_tokens: 3000,
    });

    const analysis = completion.choices[0]?.message?.content || 'Analysis could not be generated.';
    const tokensUsed = completion.usage?.total_tokens || 0;

    console.log(`✅ Analysis generated successfully. Tokens used: ${tokensUsed}`);

    return {
      analysis,
      tokensUsed,
      model: "llama3-70b-8192"
    };

  } catch (error) {
    console.error('❌ Groq API error:', error);

    // Fallback to mock analysis if Groq fails
    return {
      analysis: generateFallbackAnalysis(businessData, analysisType),
      tokensUsed: 0,
      model: "fallback"
    };
  }
}

// Build the prompt for Groq based on business data and questions
function buildAnalysisPrompt(businessData, questions, analysisType) {
  let prompt = `Please provide a comprehensive ${analysisType.toUpperCase()} analysis for the following business:\n\n`;

  prompt += `**Business Information:**\n`;
  prompt += `- Name: ${businessData.name}\n`;
  prompt += `- Description: ${businessData.description}\n`;
  if (businessData.industry) prompt += `- Industry: ${businessData.industry}\n`;
  if (businessData.target_audience) prompt += `- Target Audience: ${businessData.target_audience}\n`;
  if (businessData.products) prompt += `- Products/Services: ${businessData.products}\n`;

  prompt += `\n**Questionnaire Responses:**\n`;
  questions.forEach((q, index) => {
    prompt += `${index + 1}. **Question (${q.phase} phase, ${q.severity}):** ${q.question}\n`;
    prompt += `   **Answer:** ${q.answer}\n\n`;
  });

  if (analysisType === 'swot') {
    prompt += `\nPlease provide a detailed SWOT analysis with the following structure:
    
**SWOT Analysis for ${businessData.name}**

Based on the information provided, here's your comprehensive strategic analysis:

**Strengths** (Internal positive factors)
- Identify 4-5 key strengths based on the responses
- Focus on competitive advantages, unique capabilities, and internal assets
- Be specific about what makes this business strong

**Weaknesses** (Internal areas for improvement)  
- Identify 4-5 key weaknesses that need attention
- Focus on gaps, limitations, and areas requiring improvement
- Be constructive and specific about what needs work

**Opportunities** (External positive factors)
- Identify 4-5 market opportunities the business can pursue
- Focus on growth potential, market trends, and external possibilities
- Consider industry trends and market conditions

**Threats** (External challenges)
- Identify 4-5 potential threats and challenges
- Focus on market risks, competitive pressures, and external challenges
- Consider industry disruptions and market changes

**Strategic Recommendations**
- Provide 5-6 specific, actionable recommendations
- Prioritize the most important next steps for growth
- Include both short-term and long-term strategic actions
- Focus on how to leverage strengths and opportunities while addressing weaknesses and threats

**Key Performance Indicators (KPIs) to Track**
- Suggest 3-4 key metrics the business should monitor
- Align KPIs with the strategic recommendations

Format the response in clear markdown with proper headings and bullet points. Be specific, actionable, and insightful.`;
  } else if (analysisType === 'financial') {
    prompt += `\nPlease provide a financial analysis focusing on:
    
**Financial Analysis for ${businessData.name}**

**Revenue Analysis**
- Revenue streams and potential
- Pricing strategy recommendations
- Market size and capture potential

**Cost Structure Analysis**
- Key cost drivers
- Cost optimization opportunities
- Break-even analysis insights

**Profitability Assessment**
- Margin analysis
- Profitability improvement recommendations
- Investment requirements

**Financial Recommendations**
- Top 3-5 financial priorities
- Funding requirements and options
- Risk mitigation strategies`;
  }

  return prompt;
}

// Fallback analysis if Groq API fails
function generateFallbackAnalysis(businessData, analysisType) {
  if (analysisType === 'swot') {
    return `**SWOT Analysis for ${businessData.name}**

Based on your responses, here's your strategic analysis:

**Strengths**
• Clear business concept and focused value proposition
• Understanding of target market and customer needs
• Founder expertise and domain knowledge
• Ability to adapt quickly to market changes
• Direct customer relationships and feedback loops

**Weaknesses**
• Limited brand recognition in competitive market
• Resource constraints for rapid scaling and growth
• Dependency on founder for key business operations
• Need for enhanced digital marketing and online presence
• Limited financial resources for major investments

**Opportunities**
• Growing market demand in your business sector
• Potential for digital transformation and automation
• Opportunities for strategic partnerships and collaborations
• Expansion into adjacent markets or new customer segments
• Development of additional products or service offerings

**Threats**
• Increasing competition from established market players
• Economic uncertainties affecting customer spending patterns
• Rapid technological changes requiring constant adaptation
• Potential market saturation in your current niche
• Regulatory changes that could impact operations

**Strategic Recommendations**
• Focus on building strong customer relationships and retention
• Invest in digital marketing and establishing online presence
• Develop scalable systems and standardized processes
• Consider strategic partnerships for growth and expansion
• Build a strong brand identity and market positioning
• Diversify revenue streams to reduce dependency risk

**Key Performance Indicators (KPIs) to Track**
• Customer acquisition cost and lifetime value
• Monthly recurring revenue and growth rate
• Customer satisfaction and Net Promoter Score
• Market share and competitive positioning metrics

*Note: This analysis is based on your current responses. Complete additional phases for more detailed insights and recommendations.*`;
  }

  return `Analysis for ${businessData.name} could not be generated at this time. Please try again later.`;
}

// Extract business data from user answers
function extractBusinessDataFromAnswers(answers) {
  const businessData = {
    name: 'Your Business',
    description: '',
    industry: '',
    target_audience: '',
    products: ''
  };

  // Question 1: Business name and description
  if (answers['1']) {
    const answer = answers['1'].answer;
    businessData.description = answer;

    // Try to extract business name
    const namePatterns = [
      /(?:we are|i am|this is|called|business is|company is)\s+([A-Z][a-zA-Z\s&.-]+?)(?:\.|,|$)/i,
      /^([A-Z][a-zA-Z\s&.-]+?)\s+(?:is|provides|offers|teaches)/i
    ];

    for (const pattern of namePatterns) {
      const match = answer.match(pattern);
      if (match && match[1] && match[1].length <= 50) {
        businessData.name = match[1].trim();
        break;
      }
    }
  }

  // Question 2: Industry and location
  if (answers['2']) {
    businessData.industry = answers['2'].answer;
  }

  // Question 3: Target audience
  if (answers['3']) {
    businessData.target_audience = answers['3'].answer;
  }

  // Question 4: Products/services
  if (answers['4']) {
    businessData.products = answers['4'].answer;
  }

  return businessData;
}

// ===============================
// AUTHENTICATION ENDPOINTS (Same as before)
// ===============================

// User Registration
app.post('/api/users', async (req, res) => {
  try {
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

    const hashedPassword = await bcrypt.hash(password, 12);

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
// QUESTIONS ENDPOINTS (Same as before)
// ===============================

// POST: Add Questions (Single or Multiple)
app.post('/api/questions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { questions, overwrite = true } = req.body;

    if (!questions || (!Array.isArray(questions) && typeof questions !== 'object')) {
      return res.status(400).send({
        message: 'Questions data is required. Send single question object or array of questions.'
      });
    }

    const questionsArray = Array.isArray(questions) ? questions : [questions];
    const validatedQuestions = [];
    const errors = [];

    for (let i = 0; i < questionsArray.length; i++) {
      const q = questionsArray[i];

      if (!q.id || !q.question || !q.severity || !q.phase) {
        errors.push(`Question ${i + 1}: Missing required fields (id, question, severity, phase)`);
        continue;
      }

      if (typeof q.id !== 'number') {
        errors.push(`Question ${i + 1}: ID must be a number`);
        continue;
      }

      if (typeof q.question !== 'string' || q.question.trim().length === 0) {
        errors.push(`Question ${i + 1}: Question text must be a non-empty string`);
        continue;
      }

      if (!['mandatory', 'optional'].includes(q.severity)) {
        errors.push(`Question ${i + 1}: Severity must be 'mandatory' or 'optional'`);
        continue;
      }

      if (!['initial', 'essential', 'good', 'excellent'].includes(q.phase)) {
        errors.push(`Question ${i + 1}: Phase must be 'initial', 'essential', 'good', or 'excellent'`);
        continue;
      }

      if (!overwrite) {
        const existingQuestion = await Question.findOne({ id: q.id });
        if (existingQuestion) {
          errors.push(`Question ${i + 1}: ID ${q.id} already exists`);
          continue;
        }
      }

      validatedQuestions.push({
        id: q.id,
        question: q.question.trim(),
        severity: q.severity,
        phase: q.phase
      });
    }

    if (errors.length > 0) {
      return res.status(400).send({
        message: 'Validation errors found',
        errors: errors
      });
    }

    let savedQuestions;
    let operationMessage;

    if (overwrite) {
      const existingCount = await Question.countDocuments();
      await Question.deleteMany({});
      console.log(`🗑️  Deleted ${existingCount} existing questions`);

      savedQuestions = await Question.insertMany(validatedQuestions);
      operationMessage = `Successfully replaced all questions. Deleted ${existingCount} existing questions and added ${savedQuestions.length} new questions.`;
      console.log(`✅ Replaced ${existingCount} questions with ${savedQuestions.length} new questions`);
    } else {
      savedQuestions = await Question.insertMany(validatedQuestions);
      operationMessage = `Successfully added ${savedQuestions.length} question(s)`;
      console.log(`✅ Added ${savedQuestions.length} questions successfully`);
    }

    const stats = {
      total_questions: savedQuestions.length,
      operation: overwrite ? 'overwrite' : 'add',
      severity_breakdown: {
        mandatory: validatedQuestions.filter(q => q.severity === 'mandatory').length,
        optional: validatedQuestions.filter(q => q.severity === 'optional').length
      },
      phase_breakdown: {
        initial: validatedQuestions.filter(q => q.phase === 'initial').length,
        essential: validatedQuestions.filter(q => q.phase === 'essential').length,
        good: validatedQuestions.filter(q => q.phase === 'good').length,
        excellent: validatedQuestions.filter(q => q.phase === 'excellent').length
      }
    };

    res.status(201).send({
      message: operationMessage,
      questions: savedQuestions.map(q => ({
        id: q.id,
        question: q.question,
        severity: q.severity,
        phase: q.phase
      })),
      statistics: stats
    });

  } catch (error) {
    console.error('Add/Update questions error:', error);

    if (error.code === 11000) {
      return res.status(400).send({
        message: 'Duplicate question ID found',
        error: 'One or more question IDs already exist in the database'
      });
    }

    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// GET: Retrieve All Questions (with optional filters)
app.get('/api/questions', authenticateToken, async (req, res) => {
  try {
    const {
      severity,
      phase,
      id,
      sort_by = 'id',
      sort_order = 'asc'
    } = req.query;

    const query = {};

    if (severity && ['mandatory', 'optional'].includes(severity)) {
      query.severity = severity;
    }

    if (phase && ['initial', 'essential', 'good', 'excellent'].includes(phase)) {
      query.phase = phase;
    }

    if (id) {
      const questionId = parseInt(id);
      if (!isNaN(questionId)) {
        query.id = questionId;
      }
    }

    const sortOptions = {};
    if (['id', 'phase', 'severity', 'created_at'].includes(sort_by)) {
      sortOptions[sort_by] = sort_order === 'desc' ? -1 : 1;
    } else {
      sortOptions.id = 1;
    }

    const questions = await Question.find(query)
      .select('id question severity phase created_at updated_at')
      .sort(sortOptions);

    const totalStats = await Question.aggregate([
      {
        $group: {
          _id: null,
          total_questions: { $sum: 1 },
          mandatory_count: {
            $sum: { $cond: [{ $eq: ['$severity', 'mandatory'] }, 1, 0] }
          },
          optional_count: {
            $sum: { $cond: [{ $eq: ['$severity', 'optional'] }, 1, 0] }
          },
          initial_count: {
            $sum: { $cond: [{ $eq: ['$phase', 'initial'] }, 1, 0] }
          },
          essential_count: {
            $sum: { $cond: [{ $eq: ['$phase', 'essential'] }, 1, 0] }
          },
          good_count: {
            $sum: { $cond: [{ $eq: ['$phase', 'good'] }, 1, 0] }
          },
          excellent_count: {
            $sum: { $cond: [{ $eq: ['$phase', 'excellent'] }, 1, 0] }
          }
        }
      }
    ]);

    const response = {
      questions: questions.map(q => ({
        id: q.id,
        question: q.question,
        severity: q.severity,
        phase: q.phase,
        created_at: q.created_at,
        updated_at: q.updated_at
      })),
      pagination: {
        total_found: questions.length,
        filters_applied: {
          severity: severity || 'all',
          phase: phase || 'all',
          id: id || 'all'
        },
        sort: {
          sort_by: sort_by,
          sort_order: sort_order
        }
      }
    };

    if (totalStats.length > 0) {
      const stats = totalStats[0];
      response.database_statistics = {
        total_questions: stats.total_questions,
        severity_breakdown: {
          mandatory: stats.mandatory_count,
          optional: stats.optional_count
        },
        phase_breakdown: {
          initial: stats.initial_count,
          essential: stats.essential_count,
          good: stats.good_count,
          excellent: stats.excellent_count
        }
      };
    }

    res.status(200).send(response);

  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// ===============================
// USER ANSWERS ENDPOINTS (Same as before)
// ===============================

// POST: Save Answer (Single answer per call)
app.post('/api/answers/save', authenticateToken, async (req, res) => {
  try {
    const { question_id, answer, session_id } = req.body;
    const userId = req.user.id;

    if (!question_id || !answer) {
      return res.status(400).send({
        message: 'Question ID and answer are required'
      });
    }

    if (typeof answer !== 'string' || answer.trim().length === 0) {
      return res.status(400).send({
        message: 'Answer must be a non-empty string'
      });
    }

    const question = await Question.findOne({ id: question_id });
    if (!question) {
      return res.status(404).send({
        message: `Question with ID ${question_id} not found`
      });
    }

    const allQuestions = await Question.find({}).sort({ id: 1 });

    let userAnswersDoc;

    if (session_id) {
      userAnswersDoc = await UserAnswers.findOne({
        user_id: userId,
        session_id: session_id,
        status: 'in_progress'
      });
    }

    if (!userAnswersDoc) {
      userAnswersDoc = await UserAnswers.findOne({
        user_id: userId,
        status: 'in_progress'
      });

      if (!userAnswersDoc) {
        const newSessionId = session_id || generateSessionId();
        userAnswersDoc = new UserAnswers({
          user_id: userId,
          session_id: newSessionId,
          answers: new Map(),
          progress: {
            total_questions: allQuestions.length,
            answered_questions: 0,
            mandatory_answered: 0,
            mandatory_total: allQuestions.filter(q => q.severity === 'mandatory').length,
            percentage: 0,
            current_phase: 'initial',
            phases_completed: []
          }
        });
      }
    }

    const answerData = {
      question_id: question.id,
      question_text: question.question,
      answer: answer.trim(),
      phase: question.phase,
      severity: question.severity,
      answered_at: new Date()
    };

    userAnswersDoc.answers.set(question_id.toString(), answerData);

    const answersObject = {};
    userAnswersDoc.answers.forEach((value, key) => {
      answersObject[key] = value;
    });

    const progress = calculateProgress(answersObject, allQuestions);
    userAnswersDoc.progress.total_questions = progress.total_questions;
    userAnswersDoc.progress.answered_questions = progress.answered_questions;
    userAnswersDoc.progress.mandatory_answered = progress.mandatory_answered;
    userAnswersDoc.progress.mandatory_total = progress.mandatory_total;
    userAnswersDoc.progress.percentage = progress.percentage;

    const phases = ['initial', 'essential', 'good', 'excellent'];
    let currentPhase = 'initial';

    for (const phase of phases) {
      if (checkPhaseCompletion(answersObject, phase, allQuestions)) {
        const alreadyCompleted = userAnswersDoc.progress.phases_completed.some(p => p.phase === phase);
        if (!alreadyCompleted) {
          userAnswersDoc.progress.phases_completed.push({
            phase: phase,
            completed_at: new Date()
          });
        }
        currentPhase = phase;
      } else {
        break;
      }
    }

    userAnswersDoc.progress.current_phase = currentPhase;

    if (progress.mandatory_answered >= progress.mandatory_total) {
      userAnswersDoc.status = 'completed';
      userAnswersDoc.completed_at = new Date();
    }

    userAnswersDoc.last_updated = new Date();
    await userAnswersDoc.save();

    console.log(`✅ Answer saved for user ${userId}, question ${question_id}`);

    res.status(200).send({
      message: 'Answer saved successfully',
      session_id: userAnswersDoc.session_id,
      answer: answerData,
      progress: userAnswersDoc.progress,
      status: userAnswersDoc.status,
      is_completed: userAnswersDoc.status === 'completed'
    });

  } catch (error) {
    console.error('Save answer error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// GET: Get User's Current Session
app.get('/api/answers/current', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const userAnswersDoc = await UserAnswers.findOne({
      user_id: userId,
      status: 'in_progress'
    });

    if (!userAnswersDoc) {
      return res.status(200).send({
        message: 'No active session found',
        session_id: null,
        answers: {},
        progress: {
          total_questions: 0,
          answered_questions: 0,
          mandatory_answered: 0,
          mandatory_total: 0,
          percentage: 0,
          current_phase: 'initial',
          phases_completed: []
        },
        status: 'not_started'
      });
    }

    const answersObject = {};
    userAnswersDoc.answers.forEach((value, key) => {
      answersObject[key] = value;
    });

    res.status(200).send({
      session_id: userAnswersDoc.session_id,
      answers: answersObject,
      progress: userAnswersDoc.progress,
      status: userAnswersDoc.status,
      started_at: userAnswersDoc.started_at,
      last_updated: userAnswersDoc.last_updated
    });

  } catch (error) {
    console.error('Get current session error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// GET: Get All User Sessions (History)
app.get('/api/answers/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, limit = 10, page = 1 } = req.query;

    const query = { user_id: userId };
    if (status && ['in_progress', 'completed'].includes(status)) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const sessions = await UserAnswers.find(query)
      .sort({ started_at: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalSessions = await UserAnswers.countDocuments(query);

    const formattedSessions = sessions.map(session => {
      const answersObject = {};
      session.answers.forEach((value, key) => {
        answersObject[key] = value;
      });

      return {
        session_id: session.session_id,
        status: session.status,
        progress: session.progress,
        total_answers: Object.keys(answersObject).length,
        started_at: session.started_at,
        completed_at: session.completed_at,
        last_updated: session.last_updated
      };
    });

    res.status(200).send({
      sessions: formattedSessions,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(totalSessions / parseInt(limit)),
        total_sessions: totalSessions,
        per_page: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Get session history error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// GET: Get Specific Session Details
app.get('/api/answers/session/:sessionId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionId } = req.params;

    const userAnswersDoc = await UserAnswers.findOne({
      user_id: userId,
      session_id: sessionId
    });

    if (!userAnswersDoc) {
      return res.status(404).send({
        message: 'Session not found'
      });
    }

    const answersObject = {};
    userAnswersDoc.answers.forEach((value, key) => {
      answersObject[key] = value;
    });

    res.status(200).send({
      session_id: userAnswersDoc.session_id,
      version: userAnswersDoc.version,
      status: userAnswersDoc.status,
      answers: answersObject,
      progress: userAnswersDoc.progress,
      started_at: userAnswersDoc.started_at,
      completed_at: userAnswersDoc.completed_at,
      last_updated: userAnswersDoc.last_updated
    });

  } catch (error) {
    console.error('Get session details error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// POST: Start New Session (Reset/Restart)
app.post('/api/answers/new-session', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    await UserAnswers.updateMany(
      { user_id: userId, status: 'in_progress' },
      {
        status: 'completed',
        completed_at: new Date(),
        last_updated: new Date()
      }
    );

    const allQuestions = await Question.find({}).sort({ id: 1 });

    const newSessionId = generateSessionId();
    const newSession = new UserAnswers({
      user_id: userId,
      session_id: newSessionId,
      answers: new Map(),
      progress: {
        total_questions: allQuestions.length,
        answered_questions: 0,
        mandatory_answered: 0,
        mandatory_total: allQuestions.filter(q => q.severity === 'mandatory').length,
        percentage: 0,
        current_phase: 'initial',
        phases_completed: []
      }
    });

    await newSession.save();

    console.log(`✅ New session created for user ${userId}: ${newSessionId}`);

    res.status(201).send({
      message: 'New session started successfully',
      session_id: newSessionId,
      progress: newSession.progress,
      status: 'in_progress'
    });

  } catch (error) {
    console.error('Start new session error:', error);
    res.status(500).send({
      message: 'Server error',
      error: error.message
    });
  }
});

// GET: Get Analysis History
app.get('/api/analysis/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysis_type, limit = 10, page = 1 } = req.query;

    const query = { user_id: userId };
    if (analysis_type && ['swot', 'financial', 'strategic', 'competitive'].includes(analysis_type)) {
      query.analysis_type = analysis_type;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const analyses = await Analysis.find(query)
      .sort({ generated_at: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('analysis_type business_data.name questions_used model_used tokens_used generated_at session_id');

    const totalAnalyses = await Analysis.countDocuments(query);

    res.status(200).send({
      analyses: analyses,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(totalAnalyses / parseInt(limit)),
        total_analyses: totalAnalyses,
        per_page: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Get analysis history error:', error);
    res.status(500).send({
      message: 'Error retrieving analysis history',
      error: error.message
    });
  }
});
app.post('/api/answers/bulk-save', authenticateToken, async (req, res) => {
  try {
    const { answers, session_id } = req.body;
    const userId = req.user.id;

    if (!answers || typeof answers !== 'object') {
      return res.status(400).send({ 
        message: 'Answers object is required' 
      });
    }

    const answerEntries = Object.entries(answers);
    if (answerEntries.length === 0) {
      return res.status(200).send({ 
        message: 'No answers to save',
        saved_count: 0
      });
    }

    // Get all questions for validation
    const allQuestions = await Question.find({}).sort({ id: 1 });
    const questionMap = {};
    allQuestions.forEach(q => {
      questionMap[q.id] = q;
    });

    // Find or create user session
    let userAnswersDoc;
    
    if (session_id) {
      userAnswersDoc = await UserAnswers.findOne({ 
        user_id: userId, 
        session_id: session_id,
        status: 'in_progress'
      });
    }

    if (!userAnswersDoc) {
      userAnswersDoc = await UserAnswers.findOne({ 
        user_id: userId, 
        status: 'in_progress' 
      });

      if (!userAnswersDoc) {
        const newSessionId = session_id || generateSessionId();
        userAnswersDoc = new UserAnswers({
          user_id: userId,
          session_id: newSessionId,
          answers: new Map(),
          progress: {
            total_questions: allQuestions.length,
            answered_questions: 0,
            mandatory_answered: 0,
            mandatory_total: allQuestions.filter(q => q.severity === 'mandatory').length,
            percentage: 0,
            current_phase: 'initial',
            phases_completed: []
          }
        });
      }
    }

    let savedCount = 0;
    const errors = [];

    // Process each answer
    for (const [questionId, answer] of answerEntries) {
      try {
        const questionIdNum = parseInt(questionId);
        const question = questionMap[questionIdNum];

        if (!question) {
          errors.push(`Question ID ${questionId} not found`);
          continue;
        }

        if (!answer || typeof answer !== 'string' || answer.trim().length === 0) {
          errors.push(`Invalid answer for question ${questionId}`);
          continue;
        }

        const answerData = {
          question_id: question.id,
          question_text: question.question,
          answer: answer.trim(),
          phase: question.phase,
          severity: question.severity,
          answered_at: new Date()
        };

        userAnswersDoc.answers.set(questionId.toString(), answerData);
        savedCount++;

      } catch (error) {
        errors.push(`Error processing question ${questionId}: ${error.message}`);
      }
    }

    // Update progress
    const answersObject = {};
    userAnswersDoc.answers.forEach((value, key) => {
      answersObject[key] = value;
    });

    const progress = calculateProgress(answersObject, allQuestions);
    userAnswersDoc.progress.total_questions = progress.total_questions;
    userAnswersDoc.progress.answered_questions = progress.answered_questions;
    userAnswersDoc.progress.mandatory_answered = progress.mandatory_answered;
    userAnswersDoc.progress.mandatory_total = progress.mandatory_total;
    userAnswersDoc.progress.percentage = progress.percentage;

    // Check phase completion
    const phases = ['initial', 'essential', 'good', 'excellent'];
    let currentPhase = 'initial';
    
    for (const phase of phases) {
      if (checkPhaseCompletion(answersObject, phase, allQuestions)) {
        const alreadyCompleted = userAnswersDoc.progress.phases_completed.some(p => p.phase === phase);
        if (!alreadyCompleted) {
          userAnswersDoc.progress.phases_completed.push({
            phase: phase,
            completed_at: new Date()
          });
        }
        currentPhase = phase;
      } else {
        break;
      }
    }

    userAnswersDoc.progress.current_phase = currentPhase;

    // Check if all mandatory questions are completed
    if (progress.mandatory_answered >= progress.mandatory_total) {
      userAnswersDoc.status = 'completed';
      userAnswersDoc.completed_at = new Date();
    }

    userAnswersDoc.last_updated = new Date();
    await userAnswersDoc.save();

    console.log(`✅ Bulk save completed: ${savedCount} answers saved for user ${userId}`);

    res.status(200).send({
      message: 'Bulk save completed successfully',
      session_id: userAnswersDoc.session_id,
      saved_count: savedCount,
      total_received: answerEntries.length,
      errors: errors,
      progress: userAnswersDoc.progress,
      status: userAnswersDoc.status,
      is_completed: userAnswersDoc.status === 'completed'
    });

  } catch (error) {
    console.error('Bulk save error:', error);
    res.status(500).send({ 
      message: 'Server error during bulk save', 
      error: error.message 
    });
  }
});

// GET: Get Specific Analysis
app.get('/api/analysis/:analysisId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysisId } = req.params;

    const analysis = await Analysis.findOne({
      _id: analysisId,
      user_id: userId
    });

    if (!analysis) {
      return res.status(404).send({
        message: 'Analysis not found'
      });
    }

    res.status(200).send(analysis);

  } catch (error) {
    console.error('Get analysis error:', error);
    res.status(500).send({
      message: 'Error retrieving analysis',
      error: error.message
    });
  }
});

// GET: Health check for analysis service
app.get('/api/analysis/health', (req, res) => {
  res.status(200).send({
    message: 'Analysis service is running',
    groq_enabled: !!process.env.GROQ_API_KEY,
    supported_analysis_types: ['swot', 'financial', 'strategic', 'competitive'],
    model_info: {
      primary_model: 'llama3-70b-8192',
      fallback_available: true
    },
    timestamp: new Date().toISOString()
  });
});

// ===============================
// HEALTH CHECK
// ===============================

app.get('/health', (req, res) => {
  res.status(200).send({
    message: 'Questions Management Server with Groq Analysis API is running 🚀',
    timestamp: new Date().toISOString(),
    groq_integration: !!process.env.GROQ_API_KEY,
    endpoints: {
      authentication: [
        'POST /api/users (register)',
        'POST /api/login'
      ],
      questions: [
        'POST /api/questions (admin only)',
        'GET /api/questions'
      ],
      answers: [
        'POST /api/answers/save',
        'GET /api/answers/current',
        'GET /api/answers/history',
        'GET /api/answers/session/:sessionId',
        'POST /api/answers/new-session'
      ],
      analysis: [ 
        'GET /api/analysis/history',
        'GET /api/analysis/:analysisId',
        'GET /api/analysis/health'
      ]
    }
  });
});

// Start server
app.listen(port, '0.0.0.0', () => {

});