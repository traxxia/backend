const multer = require('multer');

const errorHandler = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large. Maximum size is 5MB for logos and 10MB for documents.' });
    }
    return res.status(400).json({ error: `File upload error: ${error.message}` });
  }

  if (error.message.includes('Invalid file type')) {
    return res.status(400).json({ error: error.message });
  }

  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
};

module.exports = errorHandler;