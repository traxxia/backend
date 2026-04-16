const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');


const routes = require('./routes');
const webhookRoutes = require('./routes/webhookRoutes');
const errorHandler = require('./middleware/errorHandler');
const cron = require('node-cron');
const SubscriptionRenewalService = require('./services/subscriptionRenewalService');
const renewalLogger = require('./utils/renewalLogger');
require('./jobs/staleBetCron'); // Initializes stale bet notification scheduler

const app = express();

// Security and Performance Middlewares
app.use(helmet());
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter); // Apply rate limit to all api routes


// Background Automated Renewal Watcher
let isJobRunning = false; 

cron.schedule('*/5 * * * *', async () => {
  const { getDB } = require('./config/database');

  if (isJobRunning) {
    console.log('[Cron] Skipping — previous job still running');
    renewalLogger.warn('[Cron] Skipping — previous job still running');
    return;
  }

  try {
    const db = getDB();

    isJobRunning = true;

    console.log(`[Cron] 🕒 Running background renewal check at ${new Date().toISOString()}...`);
    renewalLogger.info(`[Cron] 🕒 Running background renewal check at ${new Date().toISOString()}...`);

    const start = Date.now();

await SubscriptionRenewalService.checkAndRenewExpiredSubscriptions();

console.log(`[Cron] Finished in ${Date.now() - start} ms`);
renewalLogger.info(`[Cron] Finished in ${Date.now() - start} ms`);

  } catch (err) {
    if (err.message === 'Database not initialized') {
      console.log(`[Cron] Database not ready yet, skipping this cycle.`);
      renewalLogger.warn(`[Cron] Database not ready yet, skipping this cycle.`);
    } else {
      console.error(`[Cron] Unexpected Error:`, err);
      renewalLogger.error(`[Cron] Unexpected Error: ${err.message}`);
    }
  } finally {
    isJobRunning = false; 
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
    const isDeep = req.query.deep === '1';
    const { getDB } = require('./config/database');
    const db = getDB();

    if (!isDeep) {
      return res.json({ status: 'healthy', database: 'connected' });
    }

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
      deep: true,
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