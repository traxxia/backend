const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const routes = require('./routes');
const webhookRoutes = require('./routes/webhookRoutes');
const errorHandler = require('./middleware/errorHandler');
const cron = require('node-cron');
const SubscriptionRenewalService = require('./services/subscriptionRenewalService');

const app = express();

// Background Automated Renewal Watcher
cron.schedule('* * * * *', () => {
  const { getDB } = require('./config/database');
  try {
    const db = getDB();
    console.log(`[Cron] 🕒 Running background renewal check at ${new Date().toISOString()}...`);
    SubscriptionRenewalService.checkAndRenewExpiredSubscriptions();
  } catch (err) {
    if (err.message === 'Database not initialized') {
      console.log(`[Cron] Database not ready yet, skipping this cycle.`);
    } else {
      console.error(`[Cron] Unexpected Error:`, err);
    }
  }
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
}));
app.options('*', cors()); // Explicitly handle preflight

// Important: Webhook route must come BEFORE bodyParser.json()
app.use('/api/webhook', (req, res, next) => {
  if (req.originalUrl === '/api/webhook') {
    console.log(`[App] Webhook Route Hit: ${req.method} ${req.originalUrl}`);
  }
  next();
}, express.raw({ type: 'application/json' }), webhookRoutes);

app.use(bodyParser.json());
// app.use(cors()); // Removed from here
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use(routes);

// Health check
app.get('/health', async (req, res) => {
  try {
    const { getDB } = require('./config/database');
    const db = getDB();

    const stats = await Promise.all([
      db.collection('companies').countDocuments(),
      db.collection('users').countDocuments(),
      db.collection('global_questions').countDocuments(),
      db.collection('user_businesses').countDocuments(),
      db.collection('user_business_conversations').countDocuments()
    ]);

    res.json({
      status: 'healthy',
      database: 'connected',
      stats: {
        companies: stats[0],
        users: stats[1],
        questions: stats[2],
        businesses: stats[3],
        conversations: stats[4]
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    const { getDB } = require('./config/database');
    const db = getDB();

    res.json({
      env_mongo_uri: process.env.MONGO_URI ? 'SET' : 'NOT SET',
      database_name: db ? db.databaseName : 'NOT CONNECTED',
      collections: db ? await db.listCollections().toArray() : []
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Error handler (must be last)
app.use(errorHandler);

module.exports = app;