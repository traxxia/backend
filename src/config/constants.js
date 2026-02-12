module.exports = {
  SECRET_KEY: process.env.SECRET_KEY || 'default_secret_key',
  PORT: process.env.PORT || 5000, // Changed from 5001 to 5000
  ALLOWED_PHASES: ['initial', 'essential', 'advanced'],
  VALID_TEMPLATE_TYPES: ['simple', 'medium'],
  VALID_SEVERITIES: ['mandatory', 'optional'],
  VALID_PHASES: ['initial', 'essential', 'good', 'advanced', 'excellent'],
  TIER_LIMITS: {
    essential: {
      max_workspaces: 1,
      can_create_projects: false,
      max_collaborators: 0,
      price_usd: 29.00
    },
    advanced: {
      max_workspaces: 3,
      can_create_projects: true,
      max_collaborators: 3,
      price_usd: 89.00
    }
  },
  MAX_BUSINESSES_PER_USER: 5, // Default/Legacy fallback
  FILE_SIZE_LIMITS: {
    LOGO: 5 * 1024 * 1024, // 5MB
    DOCUMENT: 10 * 1024 * 1024 // 10MB
  }
};