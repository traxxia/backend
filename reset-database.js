// migrate-questions-fields.js - Add severity and phase fields to existing questions
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_survey';

// Define the updated schemas to match your backend
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

const CurrentQuestions = mongoose.model('CurrentQuestions', currentQuestionsSchema);
const SurveyResponse = mongoose.model('SurveyResponse', surveyResponseSchema);

// Function to add missing fields to question objects
function addFieldsToQuestion(question) {
  return {
    ...question,
    // Add severity field if not exists (default to 'mandatory')
    severity: question.severity || 'mandatory', // 'mandatory' or 'optional'
    // Add phase field if not exists (default to 'initial')
    phase: question.phase || 'initial' // 'initial', 'essential', 'good', 'excellent'
  };
}

// Function to update a question set
function updateQuestionSet(questionSet) {
  return questionSet.map(category => ({
    ...category,
    questions: category.questions ? category.questions.map(addFieldsToQuestion) : []
  }));
}

async function migrateQuestionsFields() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true });
    console.log('✅ Connected to MongoDB');

    // Step 1: Update CurrentQuestions collection
    console.log('\n📝 Updating CurrentQuestions collection...');
    const currentQuestionSets = await CurrentQuestions.find({});
    
    let updatedQuestionSets = 0;
    for (const questionSet of currentQuestionSets) {
      const updatedQuestions = updateQuestionSet(questionSet.questions);
      
      await CurrentQuestions.updateOne(
        { _id: questionSet._id },
        { $set: { questions: updatedQuestions } }
      );
      
      updatedQuestionSets++;
      console.log(`   ✅ Updated question set version: ${questionSet.version}`);
    }
    
    console.log(`📊 Updated ${updatedQuestionSets} question sets in CurrentQuestions`);

    // Step 2: Update SurveyResponse collection
    console.log('\n📝 Updating SurveyResponse collection...');
    const surveyResponses = await SurveyResponse.find({});
    
    let updatedResponses = 0;
    for (const response of surveyResponses) {
      const updatedQuestions = updateQuestionSet(response.questions);
      
      await SurveyResponse.updateOne(
        { _id: response._id },
        { $set: { questions: updatedQuestions } }
      );
      
      updatedResponses++;
      console.log(`   ✅ Updated survey response: ${response._id}`);
    }
    
    console.log(`📊 Updated ${updatedResponses} survey responses`);

    // Step 3: Show summary
    console.log('\n🎉 Migration completed successfully!');
    console.log('📋 Summary:');
    console.log(`   - Question sets updated: ${updatedQuestionSets}`);
    console.log(`   - Survey responses updated: ${updatedResponses}`);
    
    // Step 4: Verify the migration
    console.log('\n🔍 Verifying migration...');
    const sampleQuestionSet = await CurrentQuestions.findOne().sort({ updated_at: -1 });
    if (sampleQuestionSet) {
      const sampleQuestion = sampleQuestionSet.questions[0]?.questions?.[0];
      if (sampleQuestion) {
        console.log('📋 Sample question after migration:');
        console.log(`   - Question: ${sampleQuestion.question}`);
        console.log(`   - Severity: ${sampleQuestion.severity}`);
        console.log(`   - Phase: ${sampleQuestion.phase}`);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

// Run the migration
migrateQuestionsFields();