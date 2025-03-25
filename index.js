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
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database_name';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true 
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// Health Check Route (For Render)
app.get('/health', (req, res) => {
  res.status(200).send('Backend is running 🚀');
});

// User Schema and Model
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  gender: { type: String, enum: ['Male', 'Female'], required: true },
  terms: { type: Boolean, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  created_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Response Schema and Model
const responseSchema = new mongoose.Schema({
  question_id: Number,
  rating: Number,
  reason: String
});

const Response = mongoose.model('Response', responseSchema);

const surveyAnswerSchema = new mongoose.Schema({
  user_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  question_id: { 
    type: String, 
    required: true 
  },
  category_id: { 
    type: String, 
    required: true 
  },
  selectedOption: String,
  description: String,
  created_at: { 
    type: Date, 
    default: Date.now 
  },
  updated_at: { 
    type: Date, 
    default: Date.now 
  }
});

// Create composite index to ensure one answer per question per user
surveyAnswerSchema.index({ user_id: 1, question_id: 1 }, { unique: true });

const SurveyAnswer = mongoose.model('surveyAnswers', surveyAnswerSchema);

// Routes
app.post('/register', async (req, res) => {
  try {
    console.log(req.body);
    const { name, description, gender, terms, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).send({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, description, gender, terms, email, password: hashedPassword });

    await newUser.save();
    res.status(200).send({ message: 'Registration successful' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send({ message: 'Email and password are required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).send({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, email: user.email }, secretKey, { expiresIn: '1h' });
    res.status(200).send({ message: 'Login successful', token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).send({ message: 'No token provided' });

  jwt.verify(token, secretKey, (err, user) => {
    if (err) return res.status(403).send({ message: 'Invalid token' });

    req.user = user;
    next();
  });
};
 
app.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).send({ message: 'User not found' });

    res.send({ 
      message: `Welcome to the dashboard, ${user.name}`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});


// Insert Responses into Database
app.post('/api/analyse', async (req, res) => {
  try {
    const { answers } = req.body;
    
    const responsePromises = answers.map((answer, index) => {
      const newResponse = new Response({
        question_id: index + 1,
        rating: answer.rating,
        reason: answer.reason
      });
      return newResponse.save();
    });
    
    await Promise.all(responsePromises);
    res.status(200).send({ message: 'Answers submitted for analysis.' });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Save multiple answers at once
app.post('/api/survey/answers', authenticateToken, async (req, res) => {
  try {
    const { answers } = req.body;
    
    if (!answers || !Array.isArray(answers)) {
      return res.status(400).send({ message: 'Answers array is required' });
    }
    
    const operations = answers.map(answer => ({
      updateOne: {
        filter: { 
          user_id: req.user.id,
          question_id: answer.question_id
        },
        update: {
          user_id: req.user.id,
          question_id: answer.question_id,
          category_id: answer.category_id,
          selectedOption: answer.selectedOption,
          description: answer.description,
          updated_at: Date.now()
        },
        upsert: true
      }
    }));
    
    const result = await SurveyAnswer.bulkWrite(operations);
    
    res.status(200).send({ 
      message: 'Answers saved successfully', 
      result
    });
  } catch (error) {
    console.error('Save multiple answers error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Get all answers for the current user
app.get('/api/survey/answers', authenticateToken, async (req, res) => {
  try {
    const answers = await SurveyAnswer.find({ user_id: req.user.id });
    
    // Convert array to object with question_id as keys for easier frontend use
    const answersMap = {};
    answers.forEach(answer => {
      answersMap[answer.question_id] = {
        selectedOption: answer.selectedOption,
        description: answer.description,
        category_id: answer.category_id
      };
    });
    
    res.status(200).send({ answers: answersMap });
  } catch (error) {
    console.error('Get answers error:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`🚀 Backend running on port ${port}`));
