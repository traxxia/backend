const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_survey';

async function setupDatabase() {
  try {
    console.log('🔄 Setting up Audit Trail Database...\n');
    
    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, { 
      useNewUrlParser: true,
      useUnifiedTopology: true 
    });
    console.log('✅ Connected to MongoDB');
    
    // Import schemas from your server.js or define them here
    console.log('\n🏗️  Creating database indexes...');
    
    // The schemas and indexes will be created automatically when the server starts
    // This script primarily ensures the database is accessible and creates sample data
    
    // Check collections
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`📋 Found ${collections.length} existing collections`);
    
    // Create admin user if needed
    console.log('\n👤 Setting up admin user...');
    
    const User = mongoose.model('User', new mongoose.Schema({
      name: String,
      email: String,
      password: String,
      role: String,
      company: String,
      created_at: { type: Date, default: Date.now }
    }));
    
    const existingAdmin = await User.findOne({ email: 'admin@traxxia.com' });
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash('admin123', 12);
      const adminUser = new User({
        name: 'System Administrator',
        email: 'admin@traxxia.com',
        password: hashedPassword,
        role: 'admin',
        company: 'Traxxia'
      });
      
      await adminUser.save();
      console.log('✅ Admin user created');
    } else {
      console.log('✅ Admin user already exists');
    }
    
    console.log('\n🎉 Database setup completed successfully!');
    console.log('');
    console.log('📊 Next steps:');
    console.log('1. Start your server: npm start');
    console.log('2. Test endpoints: npm run test:audit');
    console.log('3. Login with: admin@traxxia.com / admin123');
    console.log('');
    console.log('🔗 Test login:');
    console.log('curl -X POST http://localhost:5000/api/login \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log('  -d \'{"email":"admin@traxxia.com","password":"admin123"}\'');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Database setup failed:', error);
    console.log('\n🔧 Troubleshooting:');
    console.log('- Ensure MongoDB is running: mongod');
    console.log('- Check MONGO_URI in .env file');
    console.log('- Verify database permissions');
    process.exit(1);
  }
}

// Command line interface
const command = process.argv[2];

switch (command) {
  case 'setup':
    setupDatabase();
    break;
  case 'cleanup':
    // Add cleanup functionality if needed
    console.log('Cleanup functionality can be added here');
    break;
  default:
    console.log('Usage: node setup-audit-database.js setup');
    break;
}
