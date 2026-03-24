const validateObjectId = (id) => {
  const { ObjectId } = require('mongodb');
  return ObjectId.isValid(id);
};

const sanitizeInput = (input) => {
  if (typeof input === 'string') {
    return input.trim();
  }
  return input;
};

const formatDate = (date) => {
  return new Date(date).toISOString();
};

const createPaginationMeta = (total, page, limit) => {
  return {
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    total_pages: Math.ceil(total / parseInt(limit)),
    has_next: parseInt(page) < Math.ceil(total / parseInt(limit)),
    has_prev: parseInt(page) > 1
  };
};

const calculateNextReviewDate = (lastReviewed, cadence) => {
  if (!lastReviewed || !cadence) return null;
  const date = new Date(lastReviewed);

  switch (cadence.trim().toLowerCase()) {
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'biweekly':
      date.setDate(date.getDate() + 14);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'quarterly':
      date.setMonth(date.getMonth() + 3);
      break;
    default:
      return null;
  }
  return date;
};

const isProjectStale = (nextReviewDate) => {
  if (!nextReviewDate) return false;
  const next = new Date(nextReviewDate);
  if (isNaN(next.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const nextDate = new Date(next);
  nextDate.setHours(0, 0, 0, 0);

  return today.getTime() > nextDate.getTime();
};

module.exports = {
  validateObjectId,
  sanitizeInput,
  formatDate,
  createPaginationMeta,
  calculateNextReviewDate,
  isProjectStale
};