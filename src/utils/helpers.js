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

module.exports = {
  validateObjectId,
  sanitizeInput,
  formatDate,
  createPaginationMeta
};