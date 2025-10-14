const { MongoClient } = require('mongodb');

let db;

const connectToMongoDB = async () => {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_simple';
    
    console.log('=== MONGODB DEBUG INFO ===');
    console.log('Raw MONGO_URI from env:', process.env.MONGO_URI ? 'SET' : 'NOT SET');
    console.log('Using MONGO_URI:', MONGO_URI.replace(/\/\/.*:.*@/, '//***:***@'));

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();

    console.log('Connected to database:', db.databaseName);
    console.log('=== END DEBUG INFO ===');

    return db;
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  }
};

const getDB = () => {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
};

module.exports = { connectToMongoDB, getDB };