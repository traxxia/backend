const result = require('dotenv').config();

if (result.error) {
  console.log('.env file not found. Using system environment variables.');
} else {
  console.log('Environment variables loaded from .env');
}
const app = require('./src/app');
const { connectToMongoDB } = require('./src/config/database');
const { createAuditIndexes, runAuditTrailMigration } = require('./src/services/auditService');
const { getDB } = require('./src/config/database');
const bcrypt = require('bcryptjs');
const { PORT } = require('./src/config/constants');
const { disconnectFromMongoDB } = require('./src/config/database');

async function initializeSystem() {
  try {
    const db = getDB();

    await createAuditIndexes();
    await runAuditTrailMigration();

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
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Traxxia API running on port ${PORT}`);
      console.log(`Server accessible at: http://localhost:${PORT}`);
    });

    const shutdown = async (signal) => {
      console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
      server.close(async () => {
        console.log('[Server] HTTP server closed.');
        await disconnectFromMongoDB();
        process.exit(0);
      });
      
      setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  })
  .catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });