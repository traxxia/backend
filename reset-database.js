// clear-collections.js - Clear all collections instead of dropping database
const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_survey';

async function clearAllCollections() {
  try {
    console.log('🔄 Connecting to MongoDB Atlas...');
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true });
    
    console.log('📋 Getting all collections...');
    const collections = await mongoose.connection.db.listCollections().toArray();
    
    console.log(`Found ${collections.length} collections:`);
    collections.forEach(collection => {
      console.log(`  - ${collection.name}`);
    });
    
    console.log('\n🗑️  Clearing all collections...');
    
    for (const collection of collections) {
      const collectionName = collection.name;
      console.log(`   Clearing ${collectionName}...`);
      await mongoose.connection.db.collection(collectionName).deleteMany({});
      console.log(`   ✅ ${collectionName} cleared`);
    }
    
    console.log('\n🎉 All collections cleared successfully!');
    console.log('📝 You can now run: node create-admin.js');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing collections:', error);
    process.exit(1);
  }
}

clearAllCollections();