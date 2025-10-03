module.exports = {
  SECRET_KEY: process.env.SECRET_KEY || 'default_secret_key',
  PORT: process.env.PORT || 5000, // Changed from 5001 to 5000
  ALLOWED_PHASES: ['initial', 'essential', 'advanced'],
  VALID_TEMPLATE_TYPES: ['simple', 'medium'],
  VALID_SEVERITIES: ['mandatory', 'optional'],
  VALID_PHASES: ['initial', 'essential', 'good', 'advanced', 'excellent'],
  MAX_BUSINESSES_PER_USER: 5,
  FILE_SIZE_LIMITS: {
    LOGO: 5 * 1024 * 1024, // 5MB
    DOCUMENT: 10 * 1024 * 1024 // 10MB
  }
};