module.exports = {
  SECRET_KEY: process.env.SECRET_KEY || 'default_secret_key',
  PORT: process.env.PORT || 5000, // Changed from 5001 to 5000
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  ALLOWED_PHASES: ['initial', 'essential', 'advanced'],
  VALID_TEMPLATE_TYPES: ['simple', 'medium'],
  VALID_SEVERITIES: ['mandatory', 'optional'],
  VALID_PHASES: ['initial', 'essential', 'advanced', 'excellent'],
  PROJECT_LAUNCH_STATUS: {
    UNLAUNCHED: 'unlaunched',
    PENDING_LAUNCH: 'pending_launch',
    LAUNCHED: 'launched'
  },
  PROJECT_STATES: {
    DRAFT: 'draft',
    KILLED: 'killed',
    ACTIVE: 'active',
    AT_RISK: 'at risk',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    SCALED: 'scaled'
  },
  MAX_BUSINESSES_PER_USER: 5, // Default/Legacy fallback
  FILE_SIZE_LIMITS: {
    LOGO: 5 * 1024 * 1024, // 5MB
    DOCUMENT: 10 * 1024 * 1024 // 10MB
  }
};