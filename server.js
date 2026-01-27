const result = require('dotenv').config();

if (result.error) {
  console.log('.env file not found. Using system environment variables.');
} else {
  console.log('Environment variables loaded from .env');
}
const app = require('./src/app');
const { connectToMongoDB } = require('./src/config/database');
const { createAuditIndexes } = require('./src/services/auditService');
const { getDB } = require('./src/config/database');
const bcrypt = require('bcryptjs');
const { PORT } = require('./src/config/constants');

async function initializeSystem() {
  try {
    const db = getDB();

    await createAuditIndexes();

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

    console.log('System initialized successfully');
  } catch (error) {
    console.error('System initialization failed:', error);
  }
}

connectToMongoDB()
  .then(async () => {
    await initializeSystem();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Traxxia API running on port ${PORT}`);
      console.log(`Server accessible at: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });