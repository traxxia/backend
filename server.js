const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();
const blobService = require('./blobService');

const app = express();
const port = process.env.PORT || 5001;
const secretKey = process.env.SECRET_KEY || 'default_secret_key';
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const financialDocsDir = path.join(__dirname, 'uploads', 'financial-documents');

app.use(bodyParser.json());
app.use(cors());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/traxxia_simple';
let db;
const uploadsDir = path.join(__dirname, 'uploads', 'logos');
const fsSync = require('fs');
if (!fsSync.existsSync(uploadsDir)) {
  fsSync.mkdirSync(uploadsDir, { recursive: true });
}
// ===============================
// DATABASE CONNECTION & SETUP
// ===============================

const ensureFinancialDocsDir = async () => {
  try {
    await fs.access(financialDocsDir);
  } catch (error) {
    await fs.mkdir(financialDocsDir, { recursive: true });
    console.log('Financial documents directory created');
  }
};

// Configure multer for financial documents
const financialDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit for financial documents
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, Excel, CSV, and image files are allowed.'), false);
    }
  }
});

async function connectToMongoDB() {
  try {
    console.log('=== MONGODB DEBUG INFO ===');
    console.log('Raw MONGO_URI from env:', process.env.MONGO_URI ? 'SET' : 'NOT SET');
    console.log('Using MONGO_URI:', MONGO_URI.replace(/\/\/.*:.*@/, '//***:***@'));

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();

    // Log the actual database name being used
    console.log('Connected to database:', db.databaseName);
    console.log('=== END DEBUG INFO ===');

    await initializeSystem();
    await ensureFinancialDocsDir();
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    process.exit(1);
  }
}
async function createAuditIndexes() {
  try {
    // Create indexes for better query performance
    await db.collection('audit_trail').createIndexes([
      // Index on user_id for filtering by user
      { key: { user_id: 1 } },

      // Index on timestamp for date range queries (descending for recent first)
      { key: { timestamp: -1 } },

      // Index on event_type for filtering by event type
      { key: { event_type: 1 } },

      // Compound index for common query patterns
      { key: { user_id: 1, timestamp: -1 } },
      { key: { event_type: 1, timestamp: -1 } },

      // TTL index to automatically delete old audit entries after 1 year
      { key: { timestamp: 1 }, expireAfterSeconds: 31536000 } // 365 days
    ]);

    console.log('Audit trail indexes created successfully');
  } catch (error) {
    console.error('Failed to create audit trail indexes:', error);
  }
}

async function initializeSystem() {
  try {
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
  } catch (error) {
    console.error('System initialization failed:', error);
  }
}

// ===============================
// MIDDLEWARE
// ===============================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('❌ No token provided');
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, secretKey, async (err, decoded) => {
    if (err) {
      console.log('❌ JWT verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid token' });
    }

    console.log('✅ JWT decoded successfully');
    console.log('Decoded user ID:', decoded.id);
    console.log('Decoded email:', decoded.email);
    console.log('Decoded role:', decoded.role);

    const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.id) });
    if (!user) {
      console.log('❌ User not found in database');
      return res.status(403).json({ error: 'User not found' });
    }

    const role = await db.collection('roles').findOne({ _id: user.role_id });
    console.log('✅ User found:', user.email);
    console.log('✅ Role found:', role?.role_name);

    req.user = { ...user, role };
    console.log('=== END AUTH DEBUG ===');
    next();
  });
};

const requireAdmin = (req, res, next) => {
  console.log('=== ADMIN PERMISSION CHECK ===');
  console.log('User email:', req.user?.email);
  console.log('User role:', req.user?.role?.role_name);
  console.log('Required roles: super_admin, company_admin');

  const role = req.user?.role?.role_name;
  const isAdmin = ['super_admin', 'company_admin'].includes(role);

  console.log('Is admin?', isAdmin);
  console.log('=== END ADMIN CHECK ===');

  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user.role.role_name !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, 'company_logo_' + uniqueSuffix + ext);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'), false);
    }
  }
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===============================
// FINANCIAL DOCUMENT APIs
// ===============================

// app.put('/api/businesses/:id/financial-document',
//   authenticateToken,
//   financialDocUpload.single('document'),
//   async (req, res) => {
//     try {
//       const businessId = req.params.id;
//       const uploadedFile = req.file;
//       const { template_type, template_name, validation_confidence, upload_mode } = req.body;

//       if (!uploadedFile) {
//         return res.status(400).json({ error: 'No file uploaded' });
//       }

//       // Validate template_type if provided
//       const validTemplateTypes = ['simple', 'medium'];;
//       if (template_type && !validTemplateTypes.includes(template_type)) {
//         return res.status(400).json({
//           error: `Invalid template type. Must be one of: ${validTemplateTypes.join(', ')}`
//         });
//       }

//       // Validate business exists and belongs to user
//       const business = await db.collection('user_businesses').findOne({
//         _id: new ObjectId(businessId),
//         user_id: new ObjectId(req.user._id)
//       });

//       if (!business) {
//         // Clean up uploaded file if business not found
//         await fs.unlink(uploadedFile.path).catch(console.error);
//         return res.status(404).json({ error: 'Business not found or access denied' });
//       }

//       let previousDocument = null;
//       let action = 'uploaded';

//       // Check if there's an existing document
//       if (business.financial_document && business.financial_document.file_path) {
//         previousDocument = {
//           filename: business.financial_document.filename,
//           original_name: business.financial_document.original_name,
//           upload_date: business.financial_document.upload_date,
//           template_type: business.financial_document.template_type || 'unknown'
//         };
//         action = 'replaced';

//         // Delete existing file
//         try {
//           await fs.unlink(business.financial_document.file_path);
//           console.log(`Deleted previous document: ${business.financial_document.file_path}`);
//         } catch (error) {
//           console.warn(`Failed to delete previous document: ${error.message}`);
//         }
//       }

//       // Update business with new document info including template type
//       const documentData = {
//         filename: uploadedFile.filename,
//         original_name: uploadedFile.originalname,
//         file_path: uploadedFile.path,
//         file_type: uploadedFile.mimetype,
//         file_size: uploadedFile.size,
//         upload_date: new Date(),
//         uploaded_by: new ObjectId(req.user._id),
//         is_processed: false,
//         // New fields for template tracking
//         template_type: template_type || 'unknown',
//         template_name: template_name || 'Unknown Template',
//         validation_confidence: validation_confidence || 'medium',
//         upload_mode: upload_mode || 'manual'
//       };

//       const updateResult = await db.collection('user_businesses').updateOne(
//         { _id: new ObjectId(businessId) },
//         {
//           $set: {
//             financial_document: documentData,
//             has_financial_document: true,
//             upload_decision_made: true,  // Add this line
//             upload_decision: 'upload',
//             updated_at: new Date()
//           }
//         }
//       );

//       if (updateResult.modifiedCount === 0) {
//         // Clean up uploaded file if database update failed
//         await fs.unlink(uploadedFile.path).catch(console.error);
//         return res.status(500).json({ error: 'Failed to update business document' });
//       }

//       // Enhanced audit logging with template information
//       await logAuditEvent(req.user._id, 'financial_document_uploaded', {
//         business_id: businessId,
//         business_name: business.business_name,
//         action: action,
//         filename: uploadedFile.originalname,
//         file_size: uploadedFile.size,
//         file_type: uploadedFile.mimetype,
//         template_type: template_type || 'unknown',
//         template_name: template_name || 'Unknown Template',
//         validation_confidence: validation_confidence || 'medium',
//         upload_mode: upload_mode || 'manual',
//         previous_document: previousDocument
//       });

//       res.json({
//         message: `Financial document ${action} successfully`,
//         action: action,
//         template_type: template_type || 'unknown',
//         template_name: template_name || 'Unknown Template',
//         previous_document: previousDocument,
//         current_document: {
//           filename: uploadedFile.originalname,
//           upload_date: documentData.upload_date,
//           file_size: uploadedFile.size,
//           file_type: uploadedFile.mimetype,
//           template_type: template_type || 'unknown',
//           template_name: template_name || 'Unknown Template',
//           validation_confidence: validation_confidence || 'medium'
//         }
//       });

//     } catch (error) {
//       console.error('Financial document upload error:', error);

//       // Clean up uploaded file on error
//       if (req.file && req.file.path) {
//         await fs.unlink(req.file.path).catch(console.error);
//       }

//       res.status(500).json({ error: 'Failed to upload financial document' });
//     }
//   }
// );

app.put('/api/businesses/:id/financial-document',
  authenticateToken,
  financialDocUpload.single('document'),
  async (req, res) => {
    try {
      const businessId = req.params.id;
      const uploadedFile = req.file;
      const { template_type, template_name, validation_confidence, upload_mode } = req.body;

      if (!uploadedFile) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Validate template_type if provided
      const validTemplateTypes = ['simple', 'medium'];;
      if (template_type && !validTemplateTypes.includes(template_type)) {
        return res.status(400).json({
          error: `Invalid template type. Must be one of: ${validTemplateTypes.join(', ')}`
        });
      }

      // Validate business exists and belongs to user
      const business = await db.collection('user_businesses').findOne({
        _id: new ObjectId(businessId),
        user_id: new ObjectId(req.user._id)
      });

      if (!business) {
        return res.status(404).json({ error: 'Business not found or access denied' });
      }

      let previousDocument = null;
      let action = 'uploaded';

      // Check if there's an existing document
      if (business.financial_document && business.financial_document.blob_url) {
        previousDocument = {
          filename: business.financial_document.filename,
          original_name: business.financial_document.original_name,
          upload_date: business.financial_document.upload_date,
          template_type: business.financial_document.template_type || 'unknown'
        };
        action = 'replaced';

        // Delete existing file
        // try {
        //   await fs.unlink(business.financial_document.file_path);
        //   console.log(`Deleted previous document: ${business.financial_document.file_path}`);
        // } catch (error) {
        //   console.warn(`Failed to delete previous document: ${error.message}`);
        // }
      }
         const blobName = `${businessId}_${Date.now()}_${uploadedFile.originalname}`;
         const blobUrl = await blobService.uploadBuffer(blobName, uploadedFile.buffer, uploadedFile.mimetype);

        const documentData = {
        filename: blobName,
        original_name: uploadedFile.originalname,
        blob_url: blobUrl, // 👈 replaces file_path
        file_type: uploadedFile.mimetype,
        file_size: uploadedFile.size,
        upload_date: new Date(),
        uploaded_by: new ObjectId(req.user._id),
        is_processed: false,
        template_type: template_type || 'unknown',
        template_name: template_name || 'Unknown Template',
        validation_confidence: validation_confidence || 'medium',
        upload_mode: upload_mode || 'manual'
      };
    

      const updateResult = await db.collection('user_businesses').updateOne(
        { _id: new ObjectId(businessId) },
        {
          $set: {
            financial_document: documentData,
            has_financial_document: true,
            upload_decision_made: true,  // Add this line
            upload_decision: 'upload',
            updated_at: new Date()
          }
        }
      );

      if (updateResult.modifiedCount === 0) {
        // Clean up uploaded file if database update failed
        await fs.unlink(uploadedFile.path).catch(console.error);
        return res.status(500).json({ error: 'Failed to update business document' });
      }

      // Enhanced audit logging with template information
      await logAuditEvent(req.user._id, 'financial_document_uploaded', {
        business_id: businessId,
        business_name: business.business_name,
        action: action,
        filename: uploadedFile.originalname,
        file_size: uploadedFile.size,
        file_type: uploadedFile.mimetype,
        template_type: template_type || 'unknown',
        template_name: template_name || 'Unknown Template',
        validation_confidence: validation_confidence || 'medium',
        upload_mode: upload_mode || 'manual',
        previous_document: previousDocument
      });

      res.json({
        message: `Financial document ${action} successfully`,
        action: action,
        template_type: template_type || 'unknown',
        template_name: template_name || 'Unknown Template',
        previous_document: previousDocument,
        current_document: {
          filename: uploadedFile.originalname,
          upload_date: documentData.upload_date,
          file_size: uploadedFile.size,
          file_type: uploadedFile.mimetype,
          template_type: template_type || 'unknown',
          template_name: template_name || 'Unknown Template',
          validation_confidence: validation_confidence || 'medium'
        }
      });

    } catch (error) {
      console.error('Financial document upload error:', error);

      // Clean up uploaded file on error
      if (req.file && req.file.path) {
        await fs.unlink(req.file.path).catch(console.error);
      }

      res.status(500).json({ error: 'Failed to upload financial document' });
    }
  }
);
// Add this new endpoint after the financial document endpoints
app.post('/api/businesses/:id/upload-decision', authenticateToken, async (req, res) => {
  try {
    const businessId = req.params.id;
    const { decision } = req.body;

    const updateData = {
      updated_at: new Date()
    };

    if (decision === 'pending') {
      updateData.upload_decision_made = false;
      updateData.upload_decision = 'pending';
    } else {
      updateData.upload_decision_made = true;
      updateData.upload_decision = decision;
    }

    const updateResult = await db.collection('user_businesses').updateOne(
      { _id: new ObjectId(businessId) },
      { $set: updateData }
    );

    res.json({ message: 'Upload decision saved', decision });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save decision' });
  }
});
// Get financial document info for a business
app.get('/api/businesses/:id/financial-document', authenticateToken, async (req, res) => {
  try {
    const businessId = req.params.id;

    // Validate business exists and belongs to user
    const business = await db.collection('user_businesses').findOne({
      _id: new ObjectId(businessId),
      user_id: new ObjectId(req.user._id)
    }, {
      projection: {
        business_name: 1,
        financial_document: 1,
        has_financial_document: 1
      }
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found or access denied' });
    }

    if (!business.has_financial_document || !business.financial_document) {
      return res.json({
        has_document: false,
        message: 'No financial document uploaded for this business'
      });
    }

    // Check if file still exists on filesystem
    let fileExists = false;
    try {
      await fs.access(business.financial_document.file_path);
      fileExists = true;
    } catch (error) {
      console.warn(`Financial document file missing: ${business.financial_document.file_path}`);
    }

    res.json({
      has_document: true,
      file_exists: fileExists,
      upload_decision_made: business.upload_decision_made || false,  // Add this line
      upload_decision: business.upload_decision || null,
      document: {
        filename: business.financial_document.original_name,
        upload_date: business.financial_document.upload_date,
        file_size: business.financial_document.file_size,
        file_type: business.financial_document.file_type,
        uploaded_by: business.financial_document.uploaded_by,
        is_processed: business.financial_document.is_processed || false,
        // Include template information
        template_type: business.financial_document.template_type || 'unknown',
        template_name: business.financial_document.template_name || 'Unknown Template',
        validation_confidence: business.financial_document.validation_confidence || 'medium',
        upload_mode: business.financial_document.upload_mode || 'manual'
      }
    });

  } catch (error) {
    console.error('Get financial document error:', error);
    res.status(500).json({ error: 'Failed to get financial document info' });
  }
});

// Delete financial document for a business
app.delete('/api/businesses/:id/financial-document', authenticateToken, async (req, res) => {
  try {
    const businessId = req.params.id;

    // Validate business exists and belongs to user
    const business = await db.collection('user_businesses').findOne({
      _id: new ObjectId(businessId),
      user_id: new ObjectId(req.user._id)
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found or access denied' });
    }

    if (!business.has_financial_document || !business.financial_document) {
      return res.status(404).json({ error: 'No financial document found for this business' });
    }

    // Delete file from filesystem
    if (business.financial_document.file_path) {
      try {
        await fs.unlink(business.financial_document.file_path);
        console.log(`Deleted financial document: ${business.financial_document.file_path}`);
      } catch (error) {
        console.warn(`Failed to delete financial document file: ${error.message}`);
      }
    }

    // Update database
    const updateResult = await db.collection('user_businesses').updateOne(
      { _id: new ObjectId(businessId) },
      {
        $unset: {
          financial_document: ""
        },
        $set: {
          has_financial_document: false,
          updated_at: new Date()
        }
      }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(500).json({ error: 'Failed to delete financial document record' });
    }

    // Log audit event
    await logAuditEvent(req.user._id, 'financial_document_deleted', {
      business_id: businessId,
      business_name: business.business_name,
      deleted_document: {
        filename: business.financial_document.original_name,
        upload_date: business.financial_document.upload_date
      }
    });

    res.json({
      message: 'Financial document deleted successfully',
      deleted_document: {
        filename: business.financial_document.original_name,
        upload_date: business.financial_document.upload_date
      }
    });

  } catch (error) {
    console.error('Delete financial document error:', error);
    res.status(500).json({ error: 'Failed to delete financial document' });
  }
});
// Fixed download endpoint - replace your existing one
// app.get('/api/businesses/:id/financial-document/download', authenticateToken, async (req, res) => {
//   try {
//     const businessId = req.params.id;

//     // Validate business exists and belongs to user (or admin access)
//     const business = await db.collection('user_businesses').findOne({
//       _id: new ObjectId(businessId),
//       user_id: new ObjectId(req.user._id)
//     });

//     if (!business) {
//       return res.status(404).json({ error: 'Business not found or access denied' });
//     }

//     if (!business.has_financial_document || !business.financial_document) {
//       return res.status(404).json({ error: 'No financial document found for this business' });
//     }

//     // Check if file exists
//     try {
//       await fs.access(business.financial_document.file_path);
//     } catch (error) {
//       return res.status(404).json({ error: 'Financial document file not found' });
//     }

//     // FIXED: Set headers for blob consumption (not file download)
//     res.setHeader('Content-Type', business.financial_document.file_type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

//     // DON'T set Content-Disposition: attachment - this makes it downloadable instead of readable
//     // res.setHeader('Content-Disposition', `attachment; filename="${business.financial_document.original_name}"`);

//     // Set CORS headers if needed
//     res.setHeader('Access-Control-Allow-Origin', '*');
//     res.setHeader('Access-Control-Allow-Methods', 'GET');

//     // Read and send file as buffer/stream (not as download)
//     const fileBuffer = await fs.readFile(business.financial_document.file_path);
//     res.send(fileBuffer);

//   } catch (error) {
//     console.error('Download financial document error:', error);
//     res.status(500).json({ error: 'Failed to download financial document' });
//   }
// });
app.get('/api/businesses/:id/financial-document/download', authenticateToken, async (req, res) => {
  try {
    const businessId = req.params.id;

    // Validate business exists and belongs to user (or admin access)
    const business = await db.collection('user_businesses').findOne({
      _id: new ObjectId(businessId),
      user_id: new ObjectId(req.user._id)
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found or access denied' });
    }

    if (!business.has_financial_document || !business.financial_document) {
      return res.status(404).json({ error: 'No financial document found for this business' });
    }

     await blobService.downloadToStream(
      business.financial_document.filename,   // blobName
      res,
      business.financial_document.file_type,  // Content-Type
      business.financial_document.original_name // download filename
    );

  } catch (error) {
    console.error('Download financial document error:', error);
    res.status(500).json({ error: 'Failed to download financial document' });
  }
});

// ===============================
// AUTHENTICATION APIs
// ===============================

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await db.collection('users').findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) {
      // Log failed login attempt
      if (user) {
        await logAuditEvent(user._id, 'login_failed', { email });
      }
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const role = await db.collection('roles').findOne({ _id: user.role_id });

    // Get company details including logo
    let company = null;
    if (user.company_id) {
      company = await db.collection('companies').findOne(
        { _id: user.company_id },
        { projection: { company_name: 1, logo: 1, industry: 1 } }
      );
    }

    const token = jwt.sign({
      id: user._id,
      email: user.email,
      role: role.role_name
    }, secretKey, { expiresIn: '24h' });

    // Log successful login
    await logAuditEvent(user._id, 'login_success', {
      email,
      role: role.role_name,
      company: company?.company_name
    });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: role.role_name,
        company: company ? {
          name: company.company_name,
          logo: company.logo,
          industry: company.industry
        } : null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, company_id, terms_accepted } = req.body;

    if (!name || !email || !password || !company_id || !terms_accepted) {
      return res.status(400).json({ error: 'All fields required including terms acceptance' });
    }

    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const company = await db.collection('companies').findOne({
      _id: new ObjectId(company_id),
      status: 'active'
    });
    if (!company) {
      return res.status(400).json({ error: 'Invalid company' });
    }

    const userRole = await db.collection('roles').findOne({ role_name: 'user' });
    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await db.collection('users').insertOne({
      name,
      email,
      password: hashedPassword,
      role_id: userRole._id,
      company_id: new ObjectId(company_id),
      terms_accepted,
      created_at: new Date()
    });

    res.json({
      message: 'Registration successful',
      user_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ===============================
// COMPANIES API
// ===============================

app.get('/api/companies', async (req, res) => {
  try {
    const companies = await db.collection('companies')
      .find({ status: 'active' })
      .project({ company_name: 1, industry: 1, logo: 1 })
      .sort({ company_name: 1 })
      .toArray();

    res.json({ companies });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// ===============================
// BUSINESSES API
// ===============================


app.get('/api/businesses', authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.query;
    let targetUserId;

    if (user_id) {
      // Admin access validation (existing code)
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users businesses' });
      }
      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }
      targetUserId = new ObjectId(user_id);
    } else {
      targetUserId = new ObjectId(req.user._id);
    }

    const businesses = await db.collection('user_businesses')
      .find({ user_id: targetUserId })
      .sort({ created_at: -1 })
      .toArray();

    // UPDATED: Get total active questions count EXCLUDING 'good' phase
    const allowedPhases = ['initial', 'essential', 'advanced'];
    const totalQuestions = await db.collection('global_questions')
      .countDocuments({ 
        is_active: true,
        phase: { $in: allowedPhases } // Only count allowed phases
      });

    // Enhanced businesses with question statistics and document status
    const enhancedBusinesses = await Promise.all(
      businesses.map(async (business) => {
        const conversations = await db.collection('user_business_conversations')
          .find({
            user_id: targetUserId,
            business_id: business._id,
            conversation_type: 'question_answer'
          })
          .toArray();

        const questionStats = {};
        conversations.forEach(conv => {
          if (conv.question_id) {
            const questionId = conv.question_id.toString();
            if (!questionStats[questionId]) {
              questionStats[questionId] = {
                hasAnswers: false,
                isComplete: false,
                answerCount: 0
              };
            }
            if (conv.answer_text && conv.answer_text.trim() !== '') {
              questionStats[questionId].hasAnswers = true;
              questionStats[questionId].answerCount++;
            }
            if (conv.metadata && conv.metadata.is_complete === true) {
              questionStats[questionId].isComplete = true;
            }
          }
        });

        // UPDATED: Only count completed questions that are in allowed phases
        const allowedQuestions = await db.collection('global_questions')
          .find({ 
            is_active: true,
            phase: { $in: allowedPhases }
          })
          .toArray();

        const allowedQuestionIds = new Set(
          allowedQuestions.map(q => q._id.toString())
        );

        // Filter question stats to only include allowed phases
        const filteredQuestionStats = Object.entries(questionStats).filter(
          ([questionId, stats]) => allowedQuestionIds.has(questionId)
        );

        const completedQuestions = filteredQuestionStats.filter(
          ([questionId, stat]) => stat.isComplete || stat.hasAnswers
        ).length;

        const pendingQuestions = totalQuestions - completedQuestions;
        const progressPercentage = totalQuestions > 0
          ? Math.round((completedQuestions / totalQuestions) * 100)
          : 0;

        return {
          ...business,
          // Include existing location fields
          city: business.city || '',
          country: business.country || '',
          location_display: [business.city, business.country].filter(Boolean).join(', '),
          // Include document status
          has_financial_document: business.has_financial_document || false,
          financial_document_info: business.has_financial_document && business.financial_document ? {
            filename: business.financial_document.original_name,
            upload_date: business.financial_document.upload_date,
            file_size: business.financial_document.file_size,
            file_type: business.financial_document.file_type
          } : null,
          question_statistics: {
            total_questions: totalQuestions, // Only allowed phases count
            completed_questions: completedQuestions, // Only from allowed phases
            pending_questions: pendingQuestions,
            progress_percentage: progressPercentage, // Based on allowed phases only
            total_answers_given: filteredQuestionStats.reduce(
              (sum, [questionId, stat]) => sum + stat.answerCount, 0
            ),
            // Add metadata about excluded phases for debugging
            excluded_phases: ['good'], // For debugging - shows what was excluded
            included_phases: allowedPhases // For debugging - shows what was included
          }
        };
      })
    );

    res.json({
      businesses: enhancedBusinesses,
      overall_stats: {
        total_businesses: businesses.length,
        total_questions_in_system: totalQuestions, // Only allowed phases
        businesses_with_location: enhancedBusinesses.filter(b => b.city || b.country).length,
        businesses_with_documents: enhancedBusinesses.filter(b => b.has_financial_document).length,
        // Add info about phase filtering
        calculation_method: 'excluding_good_phase',
        phases_included: allowedPhases,
        phases_excluded: ['good']
      },
      user_id: targetUserId.toString()
    });
  } catch (error) {
    console.error('Failed to fetch businesses:', error);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

app.post('/api/businesses', authenticateToken, async (req, res) => {
  try {
    const { business_name, business_purpose, description, city, country } = req.body;

    if (!business_name || !business_purpose) {
      return res.status(400).json({ error: 'Business name and purpose required' });
    }

    // Validate city and country if provided
    if (city && city.trim().length > 0 && city.trim().length < 2) {
      return res.status(400).json({ error: 'City must be at least 2 characters long' });
    }

    if (country && country.trim().length > 0 && country.trim().length < 2) {
      return res.status(400).json({ error: 'Country must be at least 2 characters long' });
    }

    // Check existing business count
    const existingCount = await db.collection('user_businesses')
      .countDocuments({ user_id: new ObjectId(req.user._id) });

    if (existingCount >= 5) {
      return res.status(400).json({ error: 'Maximum 5 businesses allowed' });
    }

    // Create business with new fields
    const businessData = {
      user_id: new ObjectId(req.user._id),
      business_name: business_name.trim(),
      business_purpose: business_purpose.trim(),
      description: description ? description.trim() : '',
      city: city ? city.trim() : '',
      country: country ? country.trim() : '',
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await db.collection('user_businesses').insertOne(businessData);

    // Enhanced audit logging with location data
    await logAuditEvent(req.user._id, 'business_created', {
      business_id: result.insertedId,
      business_name: business_name.trim(),
      business_purpose: business_purpose.trim(),
      description: description ? description.trim() : '',
      location: {
        city: city ? city.trim() : '',
        country: country ? country.trim() : ''
      },
      has_location: !!(city || country)
    });

    res.json({
      message: 'Business created successfully',
      business_id: result.insertedId,
      business: {
        _id: result.insertedId,
        business_name: business_name.trim(),
        business_purpose: business_purpose.trim(),
        description: description ? description.trim() : '',
        city: city ? city.trim() : '',
        country: country ? country.trim() : '',
        created_at: new Date()
      }
    });
  } catch (error) {
    console.error('Failed to create business:', error);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

// Simple DELETE business API - replaces your existing one
app.delete('/api/businesses/:id', authenticateToken, async (req, res) => {
  try {
    const businessId = new ObjectId(req.params.id);
    const userId = new ObjectId(req.user._id);

    // Get business details before deletion for audit log
    const business = await db.collection('user_businesses').findOne({
      _id: businessId,
      user_id: userId
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Count related conversations for audit info
    const conversationCount = await db.collection('user_business_conversations')
      .countDocuments({
        user_id: userId,
        business_id: businessId
      });

    // Delete the business
    const deleteResult = await db.collection('user_businesses').deleteOne({
      _id: businessId,
      user_id: userId
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Delete all related conversations
    await db.collection('user_business_conversations').deleteMany({
      user_id: userId,
      business_id: businessId
    });

    // Log business deletion
    await logAuditEvent(req.user._id, 'business_deleted', {
      business_id: businessId,
      business_name: business.business_name,
      business_purpose: business.business_purpose,
      conversations_deleted: conversationCount,
      deleted_at: new Date()
    });

    res.json({ message: 'Business and conversations deleted successfully' });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

// ===============================
// QUESTIONS API (UPDATED)
// ===============================

app.get('/api/questions', authenticateToken, async (req, res) => {
  try {
    const { phase } = req.query;

    // Define allowed phases - excluding 'good' phase
    const allowedPhases = ['initial', 'essential', 'advanced'];

    // Build the filter
    let questionFilter = {
      is_active: true,
      phase: { $in: allowedPhases } // Only include allowed phases
    };

    // If a specific phase is requested, validate it's in allowed phases
    if (phase) {
      if (!allowedPhases.includes(phase)) {
        return res.status(400).json({
          error: `Invalid phase. Allowed phases are: ${allowedPhases.join(', ')}`
        });
      }
      questionFilter.phase = phase; // Override with specific phase
    }

    const questions = await db.collection('global_questions')
      .find(questionFilter)
      .sort({ order: 1 })
      .toArray();

    res.json({
      questions,
      allowed_phases: allowedPhases,
      current_filter: phase || 'all_allowed_phases',
      total_questions: questions.length
    });
  } catch (error) {
    console.error('Failed to fetch questions:', error);
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});
// ===============================
// QUESTION MANAGEMENT APIs (Add these to your existing code)
// ===============================

app.post('/api/questions/missing-for-analysis', authenticateToken, async (req, res) => {
  try {
    const { analysis_type, business_id } = req.body;

    if (!analysis_type) {
      return res.status(400).json({ error: 'Analysis type is required' });
    }

    // Define which analysis types map to which question criteria (exact matches from your database)
    const analysisQuestionMap = {
      'swot': ['swot'],
      'customerSegmentation': ['customerSegmentation'],
      'purchaseCriteria': ['purchaseCriteria'],
      'channelHeatmap': ['channelHeatmap'],
      'loyaltyNPS': ['loyaltyNPS'],
      'capabilityHeatmap': ['capabilityHeatmap'],
      'porters': ['porters'],
      'pestel': ['pestel'],
      'strategic': ['strategic'],
      'fullSwot': ['swot'],
      'competitiveAdvantage': ['competitiveAdvantage'],
      'channelEffectiveness': ['channelEffectiveness'],
      'expandedCapability': ['expandedCapability'],
      'strategicGoals': ['strategicGoals'],
      'strategicRadar': ['strategic'],
      'cultureProfile': ['cultureProfile'],
      'productivityMetrics': ['productivityMetrics'],
      'maturityScore': ['maturityScore']
    };

    const searchTerms = analysisQuestionMap[analysis_type] || [analysis_type];

    // Create regex patterns for multiple search terms
    const regexPatterns = searchTerms.map(term => new RegExp(term, 'i'));

    // Get required questions for this analysis using exact string matching
    let requiredQuestions = [];

    for (const searchTerm of searchTerms) {
      const questions = await db.collection('global_questions')
        .find({
          is_active: true,
          used_for: { $regex: new RegExp(`\\b${searchTerm}\\b`, 'i') } // Word boundary match
        })
        .sort({ order: 1 })
        .toArray();

      requiredQuestions = requiredQuestions.concat(questions);
    }

    // Remove duplicates based on _id
    const uniqueQuestions = requiredQuestions.filter((question, index, self) =>
      index === self.findIndex(q => q._id.toString() === question._id.toString())
    );

    // Add debug logging
    console.log(`Searching for ${analysis_type} with terms:`, searchTerms);
    console.log(`Found ${uniqueQuestions.length} specific questions`);

    // For customer segmentation, if no specific questions found, 
    // require essential phase questions (typically questions 8-15)
    let questionsToCheck = uniqueQuestions;
    if (uniqueQuestions.length === 0) {
      if (analysis_type === 'customerSegmentation') {
        // Customer segmentation typically needs essential phase questions
        questionsToCheck = await db.collection('global_questions')
          .find({
            is_active: true,
            $or: [
              { phase: 'essential' },
              { order: { $gte: 8, $lte: 15 } } // Questions 8-15 are typically essential
            ]
          })
          .sort({ order: 1 })
          .toArray();

        console.log(`Using essential phase questions: ${questionsToCheck.length} questions`);
      } else {
        // For other analyses, use first 7 questions as basic requirement
        questionsToCheck = await db.collection('global_questions')
          .find({
            is_active: true,
            order: { $lte: 7 }
          })
          .sort({ order: 1 })
          .toArray();

        console.log(`Using basic requirements: ${questionsToCheck.length} questions`);
      }
    } else {
      console.log(`Using ${uniqueQuestions.length} questions found with specific criteria`);
    }

    // Get user's answered questions for this business
    const conversations = await db.collection('user_business_conversations')
      .find({
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        conversation_type: 'question_answer',
        $or: [
          { 'metadata.is_complete': true },
          { completion_status: 'complete' },
          {
            answer_text: {
              $exists: true,
              $ne: '',
              $ne: '[Question Skipped]'
            }
          }
        ]
      })
      .toArray();

    const answeredQuestionIds = new Set(
      conversations.map(conv => conv.question_id?.toString()).filter(Boolean)
    );

    console.log(`User has answered ${answeredQuestionIds.size} questions`);

    // Find missing questions
    const missingQuestions = questionsToCheck.filter(q =>
      !answeredQuestionIds.has(q._id.toString())
    );

    // Calculate completion status
    const totalRequired = questionsToCheck.length;
    const answered = totalRequired - missingQuestions.length;
    const isComplete = missingQuestions.length === 0;

    console.log(`Missing ${missingQuestions.length} out of ${totalRequired} required questions`);

    res.json({
      analysis_type,
      total_required: totalRequired,
      answered: answered,
      missing_count: missingQuestions.length,
      missing_questions: missingQuestions.map(q => ({
        _id: q._id,
        order: q.order,
        question_text: q.question_text,
        objective: q.objective,
        required_info: q.required_info,
        used_for: q.used_for
      })),
      is_complete: isComplete,
      message: isComplete
        ? `All required questions answered for ${analysis_type}`
        : `Please answer ${missingQuestions.length} more question${missingQuestions.length > 1 ? 's' : ''} to generate ${analysis_type} analysis`,
      search_criteria: searchTerms.join(', '),
      debug_info: {
        search_terms_used: searchTerms,
        questions_found_with_criteria: uniqueQuestions.length,
        fallback_used: uniqueQuestions.length === 0,
        total_answered_questions: answeredQuestionIds.size
      }
    });

  } catch (error) {
    console.error('Error checking missing questions:', error);
    res.status(500).json({ error: 'Failed to check missing questions' });
  }
});

// 1. Reorder Questions API
app.put('/api/admin/questions/reorder', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questions, phase } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions array is required' });
    }

    if (!phase) {
      return res.status(400).json({ error: 'Phase is required for reordering' });
    }

    // Validate that all questions have required fields
    const validationErrors = [];
    questions.forEach((question, index) => {
      if (!question.question_id || !question.order) {
        validationErrors.push({
          index: index,
          error: 'question_id and order are required for each question'
        });
      }
      if (!Number.isInteger(question.order) || question.order < 1) {
        validationErrors.push({
          index: index,
          error: 'order must be a positive integer'
        });
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        validation_errors: validationErrors
      });
    }

    // Verify all questions exist and belong to the specified phase
    const questionIds = questions.map(q => new ObjectId(q.question_id));
    const existingQuestions = await db.collection('global_questions')
      .find({
        _id: { $in: questionIds },
        phase: phase
      })
      .toArray();

    if (existingQuestions.length !== questions.length) {
      return res.status(400).json({
        error: 'One or more questions not found or do not belong to the specified phase'
      });
    }

    // Calculate new global orders for the reordered questions
    const phaseOrder = ['initial', 'essential', 'good', 'excellent'];
    const currentPhaseIndex = phaseOrder.indexOf(phase);
    const earlierPhases = phaseOrder.slice(0, currentPhaseIndex);
    let phaseStartOrder = 1;

    if (earlierPhases.length > 0) {
      const earlierPhasesMaxOrder = await db.collection('global_questions')
        .find({
          phase: { $in: earlierPhases },
          is_active: true
        })
        .sort({ order: -1 })
        .limit(1)
        .toArray();

      if (earlierPhasesMaxOrder.length > 0) {
        phaseStartOrder = earlierPhasesMaxOrder[0].order + 1;
      }
    }

    const bulkOps = questions.map((question, index) => {
      const newGlobalOrder = phaseStartOrder + index;

      return {
        updateOne: {
          filter: { _id: new ObjectId(question.question_id) },
          update: {
            $set: {
              order: newGlobalOrder,
              updated_at: new Date()
            }
          }
        }
      };
    });

    // Execute the reorder operations
    const result = await db.collection('global_questions').bulkWrite(bulkOps);

    // Get the updated questions to return
    const updatedQuestions = await db.collection('global_questions')
      .find({ phase: phase, is_active: true })
      .sort({ order: 1 })
      .toArray();

    res.json({
      message: 'Questions reordered successfully',
      modified_count: result.modifiedCount,
      matched_count: result.matchedCount,
      phase: phase,
      updated_questions: updatedQuestions.map(q => ({
        question_id: q._id,
        question_text: q.question_text,
        phase: q.phase,
        order: q.order
      }))
    });

  } catch (error) {
    console.error('Failed to reorder questions:', error);
    res.status(500).json({ error: 'Failed to reorder questions' });
  }
});

// 2. Delete Question API
app.delete('/api/admin/questions/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;

    if (!ObjectId.isValid(questionId)) {
      return res.status(400).json({ error: 'Invalid question ID' });
    }

    const question = await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const conversationCount = await db.collection('user_business_conversations')
      .countDocuments({ question_id: new ObjectId(questionId) });

    if (conversationCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete question with existing conversations',
        conversation_count: conversationCount
      });
    }

    const result = await db.collection('global_questions')
      .deleteOne({ _id: new ObjectId(questionId) });

    if (result.deletedCount === 0) {
      return res.status(500).json({ error: 'Failed to delete question' });
    }

    res.json({
      message: 'Question deleted successfully',
      deleted_question: {
        id: questionId,
        question_text: question.question_text,
        phase: question.phase
      }
    });

  } catch (error) {
    console.error('Failed to delete question:', error);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// 3. Edit Question API
app.put('/api/admin/questions/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const questionId = req.params.id;
    const { question_text, phase, severity, order, is_active, used_for, objective, required_info } = req.body;

    if (!ObjectId.isValid(questionId)) {
      return res.status(400).json({ error: 'Invalid question ID' });
    }

    if (!question_text || !phase || !severity) {
      return res.status(400).json({ error: 'Question text, phase, and severity are required' });
    }

    const validSeverities = ['mandatory', 'optional'];
    if (!validSeverities.includes(severity.toLowerCase())) {
      return res.status(400).json({
        error: `Severity must be one of: ${validSeverities.join(', ')}`
      });
    }

    if (order !== undefined && (!Number.isInteger(order) || order < 1)) {
      return res.status(400).json({ error: 'Order must be a positive integer' });
    }

    const existingQuestion = await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });

    if (!existingQuestion) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const updateData = {
      question_text: question_text.trim(),
      phase: phase.trim(),
      severity: severity.toLowerCase(),
      used_for: used_for || '',
      objective: objective || '',
      required_info: required_info || '',
      updated_at: new Date()
    };

    if (order !== undefined) {
      updateData.order = order;
    }

    if (is_active !== undefined) {
      updateData.is_active = Boolean(is_active);
    }

    const result = await db.collection('global_questions').updateOne(
      { _id: new ObjectId(questionId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    if (result.modifiedCount === 0) {
      return res.status(200).json({
        message: 'No changes were made to the question',
        question_id: questionId
      });
    }

    const updatedQuestion = await db.collection('global_questions')
      .findOne({ _id: new ObjectId(questionId) });

    res.json({
      message: 'Question updated successfully',
      question: {
        id: updatedQuestion._id,
        question_text: updatedQuestion.question_text,
        phase: updatedQuestion.phase,
        severity: updatedQuestion.severity,
        order: updatedQuestion.order,
        used_for: updatedQuestion.used_for,
        objective: updatedQuestion.objective,
        required_info: updatedQuestion.required_info,
        is_active: updatedQuestion.is_active,
        updated_at: updatedQuestion.updated_at
      }
    });

  } catch (error) {
    console.error('Failed to update question:', error);
    res.status(500).json({ error: 'Failed to update question' });
  }
});

// BULK UPDATE QUESTIONS API (Updates existing questions with new columns)
// ENHANCED BULK UPDATE/INSERT QUESTIONS API
app.post('/api/admin/questions/bulk', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        error: 'Questions array is required and must contain at least one question'
      });
    }

    if (questions.length > 1000) {
      return res.status(400).json({
        error: 'Maximum 1000 questions allowed per bulk upload'
      });
    }

    // Validate required fields for each question
    const validationErrors = [];
    questions.forEach((question, index) => {
      if (!question.question_text || !question.phase || !question.severity || !question.order) {
        validationErrors.push({
          index: index,
          order: question.order,
          error: 'question_text, phase, severity, and order are required'
        });
      }

      if (!Number.isInteger(question.order) || question.order < 1) {
        validationErrors.push({
          index: index,
          order: question.order,
          error: 'order must be a positive integer'
        });
      }

      const validPhases = ['initial', 'essential', 'good', 'advanced', 'excellent'];
      if (!validPhases.includes(question.phase)) {
        validationErrors.push({
          index: index,
          order: question.order,
          error: `phase must be one of: ${validPhases.join(', ')}`
        });
      }

      const validSeverities = ['mandatory', 'optional'];
      if (!validSeverities.includes(question.severity)) {
        validationErrors.push({
          index: index,
          order: question.order,
          error: `severity must be one of: ${validSeverities.join(', ')}`
        });
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        validation_errors: validationErrors
      });
    }

    // Check for duplicate orders in the payload
    const orderCounts = {};
    questions.forEach(q => {
      orderCounts[q.order] = (orderCounts[q.order] || 0) + 1;
    });

    const duplicateOrders = Object.entries(orderCounts)
      .filter(([order, count]) => count > 1)
      .map(([order, count]) => ({ order: parseInt(order), count }));

    if (duplicateOrders.length > 0) {
      return res.status(400).json({
        error: 'Duplicate orders found in payload',
        duplicate_orders: duplicateOrders
      });
    }

    // Get existing questions from database
    const existingQuestions = await db.collection('global_questions')
      .find({ is_active: true })
      .sort({ order: 1 })
      .toArray();

    console.log(`Found ${existingQuestions.length} existing questions in database`);

    const bulkOps = [];
    let matchedCount = 0;
    let newQuestionsCount = 0;
    let unmatchedQuestions = [];
    let insertedQuestions = [];

    // Process each question in the payload
    questions.forEach((newQuestion, index) => {
      const existingQuestion = existingQuestions.find(eq => eq.order === newQuestion.order);

      if (existingQuestion) {
        // Update existing question
        matchedCount++;

        bulkOps.push({
          updateOne: {
            filter: { _id: existingQuestion._id },
            update: {
              $set: {
                question_text: newQuestion.question_text.trim(),
                phase: newQuestion.phase.trim(),
                severity: newQuestion.severity.toLowerCase(),
                used_for: newQuestion.used_for || '',
                objective: newQuestion.objective || '',
                required_info: newQuestion.required_info || '',
                updated_at: new Date()
              }
            }
          }
        });
      } else {
        // Insert new question
        newQuestionsCount++;

        const newQuestionDoc = {
          question_text: newQuestion.question_text.trim(),
          phase: newQuestion.phase.trim(),
          severity: newQuestion.severity.toLowerCase(),
          order: newQuestion.order,
          used_for: newQuestion.used_for || '',
          objective: newQuestion.objective || '',
          required_info: newQuestion.required_info || '',
          is_active: true,
          created_at: new Date()
        };

        bulkOps.push({
          insertOne: {
            document: newQuestionDoc
          }
        });

        insertedQuestions.push({
          order: newQuestion.order,
          question_text: newQuestion.question_text,
          phase: newQuestion.phase
        });
      }
    });

    // Execute bulk operations
    let modifiedCount = 0;
    let insertedCount = 0;
    let result = null;

    if (bulkOps.length > 0) {
      result = await db.collection('global_questions').bulkWrite(bulkOps, { ordered: false });
      modifiedCount = result.modifiedCount || 0;
      insertedCount = result.insertedCount || 0;

      console.log(`Bulk operation completed: ${modifiedCount} updated, ${insertedCount} inserted`);
    }

    // Get final question count and updated questions
    const finalQuestionCount = await db.collection('global_questions')
      .countDocuments({ is_active: true });

    const updatedQuestions = await db.collection('global_questions')
      .find({ is_active: true })
      .sort({ order: 1 })
      .toArray();

    // Log audit event for bulk operation
    await logAuditEvent(req.user._id, 'bulk_questions_operation', {
      operation_type: 'bulk_update_insert',
      total_processed: questions.length,
      questions_updated: modifiedCount,
      questions_inserted: insertedCount,
      existing_questions_before: existingQuestions.length,
      total_questions_after: finalQuestionCount,
      new_questions_added: insertedQuestions,
      timestamp: new Date().toISOString()
    });

    res.json({
      message: 'Questions processed successfully',
      operation: 'bulk_update_insert',
      summary: {
        total_processed: questions.length,
        existing_questions_updated: modifiedCount,
        new_questions_inserted: insertedCount,
        questions_before_operation: existingQuestions.length,
        questions_after_operation: finalQuestionCount,
        questions_added: newQuestionsCount
      },
      details: {
        matched_and_updated: matchedCount,
        new_questions_added: newQuestionsCount,
        successfully_updated: modifiedCount,
        successfully_inserted: insertedCount
      },
      new_questions_added: insertedQuestions,
      database_stats: {
        questions_before: existingQuestions.length,
        questions_after: finalQuestionCount,
        net_increase: finalQuestionCount - existingQuestions.length
      },
      bulk_operation_result: result ? {
        acknowledged: result.acknowledged,
        inserted_count: result.insertedCount,
        matched_count: result.matchedCount,
        modified_count: result.modifiedCount,
        upserted_count: result.upsertedCount
      } : null
    });

  } catch (error) {
    console.error('Bulk questions operation failed:', error);

    // Log error in audit trail
    await logAuditEvent(req.user._id, 'bulk_questions_error', {
      error_message: error.message,
      operation_type: 'bulk_update_insert',
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      error: 'Failed to process questions',
      details: error.message
    });
  }
});

// ===============================
// CONVERSATIONS API
// =============================== 
app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id, user_id } = req.query;

    // Determine which user's conversations to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's conversations
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users conversations' });
      }

      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      targetUserId = new ObjectId(req.user._id);
    }

    // Get questions for the phase
    let questionFilter = { is_active: true };
    if (phase) questionFilter.phase = phase;

    const questions = await db.collection('global_questions')
      .find(questionFilter)
      .sort({ order: 1 })
      .toArray();

    // Get user's conversations
    const conversations = await db.collection('user_business_conversations')
      .find({
        user_id: targetUserId,
        conversation_type: 'question_answer',
        business_id: business_id ? new ObjectId(business_id) : null
      })
      .sort({ created_at: 1 })
      .toArray();

    // Get phase analysis results
    const phaseAnalysis = await db.collection('user_business_conversations')
      .find({
        user_id: targetUserId,
        conversation_type: 'phase_analysis',
        business_id: business_id ? new ObjectId(business_id) : null,
        ...(phase && { 'metadata.phase': phase })
      })
      .sort({ created_at: -1 })
      .toArray();

    // Get business and document information
    let businessInfo = null;
    let documentInfo = null;

    if (business_id) {
      // Fetch business details including document information
      const business = await db.collection('user_businesses').findOne(
        {
          _id: new ObjectId(business_id),
          user_id: targetUserId
        },
        {
          projection: {
            business_name: 1,
            business_purpose: 1,
            city: 1,
            country: 1,
            has_financial_document: 1,
            financial_document: 1,
            upload_decision_made: 1,
            upload_decision: 1,
            created_at: 1
          }
        }
      );

      if (business) {
        businessInfo = {
          id: business._id,
          name: business.business_name,
          purpose: business.business_purpose,
          location: {
            city: business.city || '',
            country: business.country || '',
            display: [business.city, business.country].filter(Boolean).join(', ')
          },
          upload_decision_made: business.upload_decision_made || false,  // Add this line
          upload_decision: business.upload_decision || null,
          created_at: business.created_at
        };

        // Include document information if exists
        if (business.has_financial_document && business.financial_document) {
          // Check if file actually exists on filesystem
          let fileExists = false;
          let fileContent = null;
          let fileContentBase64 = null;

          if (business.financial_document.file_path) {
            try {
              await fs.access(business.financial_document.file_path);
              fileExists = true;

              // Read the actual file content
              const fileBuffer = await fs.readFile(business.financial_document.file_path);
              fileContent = fileBuffer;

              // Convert to base64 for JSON response
              fileContentBase64 = fileBuffer.toString('base64');

            } catch (error) {
              console.warn(`Financial document file missing or unreadable: ${business.financial_document.file_path}`, error.message);
            }
          }

          documentInfo = {
            has_document: true,
            file_exists: fileExists,
            filename: business.financial_document.original_name,
            upload_date: business.financial_document.upload_date,
            file_size: business.financial_document.file_size,
            file_type: business.financial_document.file_type,
            is_processed: business.financial_document.is_processed || false,
            uploaded_by: business.financial_document.uploaded_by,

            // NEW: Include actual file content
            file_content_base64: fileContentBase64, // Base64 encoded file content
            file_content_available: !!fileContentBase64,

            // Helper information for the frontend
            download_info: {
              can_download: fileExists,
              content_type: business.financial_document.file_type,
              content_disposition: `attachment; filename="${business.financial_document.original_name}"`
            }
          };
        } else {
          documentInfo = {
            has_document: false,
            file_exists: false,
            file_content_base64: null,
            file_content_available: false,
            message: 'No financial document uploaded for this business'
          };
        }
      }
    }

    // Process each question
    const result = questions.map(question => {
      const questionConvs = conversations.filter(c =>
        c.question_id && c.question_id.toString() === question._id.toString()
      );

      const allEntries = questionConvs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // Check if question is skipped
      const isSkipped = allEntries.some(entry => entry.is_skipped === true);

      // Build conversation flow
      const conversationFlow = [];
      allEntries.forEach(entry => {
        if (entry.message_type === 'bot' && entry.message_text) {
          conversationFlow.push({
            type: 'question',
            text: entry.message_text,
            timestamp: entry.created_at,
            is_followup: entry.is_followup || false
          });
        }
        if (entry.answer_text && entry.answer_text.trim() !== '') {
          conversationFlow.push({
            type: 'answer',
            text: entry.answer_text,
            timestamp: entry.created_at,
            is_followup: entry.is_followup || false
          });
        }
      });

      // Determine completion status
      const statusEntries = questionConvs.filter(c => c.metadata && c.metadata.is_complete !== undefined);
      const latestStatusEntry = statusEntries.length > 0
        ? statusEntries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
        : null;

      let status = 'incomplete';
      if (isSkipped) {
        status = 'skipped';
      } else if (latestStatusEntry?.metadata?.is_complete) {
        status = 'complete';
      }

      const answerCount = conversationFlow.filter(item => item.type === 'answer').length;

      return {
        question_id: question._id,
        question_text: question.question_text,
        phase: question.phase,
        order: question.order,
        conversation_flow: conversationFlow,
        total_interactions: conversationFlow.length,
        total_answers: answerCount,
        completion_status: status,
        is_skipped: isSkipped,
        last_updated: allEntries.length > 0 ? allEntries[allEntries.length - 1].created_at : null
      };
    });

    // Organize analysis results by phase AND analysis type
    const analysisResultsByPhase = {};

    phaseAnalysis.forEach(analysis => {
      const analysisPhase = analysis.metadata?.phase || 'initial';
      const analysisType = analysis.metadata?.analysis_type || 'unknown';

      if (!analysisResultsByPhase[analysisPhase]) {
        analysisResultsByPhase[analysisPhase] = {
          phase: analysisPhase,
          analyses: []
        };
      }

      const existingIndex = analysisResultsByPhase[analysisPhase].analyses
        .findIndex(a => a.analysis_type === analysisType);

      const analysisData = {
        analysis_type: analysisType,
        analysis_name: analysis.message_text || `${analysisType.toUpperCase()} Analysis`,
        analysis_data: analysis.analysis_result,
        created_at: analysis.created_at,
        phase: analysisPhase
      };

      if (existingIndex !== -1) {
        if (new Date(analysis.created_at) > new Date(analysisResultsByPhase[analysisPhase].analyses[existingIndex].created_at)) {
          analysisResultsByPhase[analysisPhase].analyses[existingIndex] = analysisData;
        }
      } else {
        analysisResultsByPhase[analysisPhase].analyses.push(analysisData);
      }
    });

    // Return response with file content included
    res.json({
      conversations: result,
      phase_analysis: analysisResultsByPhase,
      total_questions: questions.length,
      completed: result.filter(r => r.completion_status === 'complete').length,
      skipped: result.filter(r => r.completion_status === 'skipped').length,
      phase: phase || 'all',
      user_id: targetUserId.toString(),

      // Enhanced business and document information with file content
      business_info: businessInfo,
      document_info: documentInfo,

      // Enhanced metadata
      metadata: {
        has_business_context: !!businessInfo,
        has_document_uploaded: documentInfo?.has_document || false,
        document_file_exists: documentInfo?.file_exists || false,
        document_content_available: documentInfo?.file_content_available || false,
        is_good_phase_ready: documentInfo?.has_document && documentInfo?.file_exists,
        request_timestamp: new Date().toISOString(),

        // File content size warning
        file_content_size: documentInfo?.file_content_base64 ?
          Math.round(documentInfo.file_content_base64.length * 0.75) : 0, // Approximate original file size
        file_content_warning: documentInfo?.file_content_base64 && documentInfo.file_content_base64.length > 1000000 ?
          'Large file content included - consider using download endpoint for better performance' : null
      }
    });

  } catch (error) {
    console.error('Failed to fetch conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get phase analysis results (updated for admin access)
app.get('/api/phase-analysis', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id, analysis_type, user_id } = req.query;

    // Determine which user's phase analysis to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's phase analysis
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users phase analysis' });
      }

      // Validate user exists and access permissions
      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Company admin can only view users from their company
      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      // Regular user requesting their own phase analysis
      targetUserId = new ObjectId(req.user._id);
    }

    let filter = {
      user_id: targetUserId,
      conversation_type: 'phase_analysis'
    };

    if (business_id) filter.business_id = new ObjectId(business_id);
    if (phase) filter['metadata.phase'] = phase;
    if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

    const analysisResults = await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    const formattedResults = analysisResults.map(analysis => ({
      analysis_id: analysis._id,
      phase: analysis.metadata?.phase,
      analysis_type: analysis.metadata?.analysis_type,
      analysis_name: analysis.message_text,
      analysis_data: analysis.analysis_result,
      created_at: analysis.created_at
    }));

    // Group by phase
    const resultsByPhase = formattedResults.reduce((acc, result) => {
      const phase = result.phase || 'unknown';
      if (!acc[phase]) {
        acc[phase] = [];
      }
      acc[phase].push(result);
      return acc;
    }, {});

    res.json({
      analysis_results: formattedResults,
      results_by_phase: resultsByPhase,
      total_analyses: formattedResults.length,
      user_id: targetUserId.toString() // Include the user ID in response for admin context
    });

  } catch (error) {
    console.error('Failed to fetch phase analysis:', error);
    res.status(500).json({ error: 'Failed to fetch phase analysis' });
  }
});

// Enhanced admin endpoint to get user data (conversations + businesses + phase analysis)
app.get('/api/admin/user-data/:user_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    const { business_id } = req.query;

    if (!ObjectId.isValid(user_id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Validate user exists and access permissions
    const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Company admin can only view users from their company
    if (req.user.role.role_name === 'company_admin') {
      if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
        return res.status(403).json({ error: 'Access denied - user not in your company' });
      }
    }

    const targetUserId = new ObjectId(user_id);

    // Build conversation filter
    let conversationFilter = {
      user_id: targetUserId,
      conversation_type: 'question_answer'
    };

    // Build phase analysis filter
    let phaseAnalysisFilter = {
      user_id: targetUserId,
      conversation_type: 'phase_analysis'
    };

    // Build business filter
    let businessFilter = { user_id: targetUserId };

    // If business_id is specified, filter data for that business only
    if (business_id && ObjectId.isValid(business_id)) {
      const businessObjectId = new ObjectId(business_id);
      conversationFilter.business_id = businessObjectId;
      phaseAnalysisFilter.business_id = businessObjectId;

      // Also validate that the business belongs to the user
      const businessExists = await db.collection('user_businesses').findOne({
        _id: businessObjectId,
        user_id: targetUserId
      });

      if (!businessExists) {
        return res.status(404).json({ error: 'Business not found for this user' });
      }
    }

    // Get all conversations for this user (and business if specified)
    const conversations = await db.collection('user_business_conversations')
      .find(conversationFilter)
      .sort({ created_at: 1 })
      .toArray();

    // Get all phase analysis for this user (and business if specified)
    const phaseAnalysis = await db.collection('user_business_conversations')
      .find(phaseAnalysisFilter)
      .sort({ created_at: -1 })
      .toArray();

    // Get all businesses for this user (always return all businesses for dropdown)
    const businesses = await db.collection('user_businesses')
      .find(businessFilter)
      .sort({ created_at: -1 })
      .toArray();

    // Get all questions for reference
    const questions = await db.collection('global_questions')
      .find({ is_active: true })
      .sort({ order: 1 })
      .toArray();

    // Transform conversations into phases structure
    const phaseMap = new Map();

    // Group conversations by question and build phase structure
    questions.forEach(question => {
      const questionConvs = conversations.filter(c =>
        c.question_id && c.question_id.toString() === question._id.toString()
      );

      if (questionConvs.length > 0) {
        const phase = question.phase;

        if (!phaseMap.has(phase)) {
          phaseMap.set(phase, {
            phase: phase,
            severity: question.severity || 'mandatory',
            questions: []
          });
        }

        const phaseData = phaseMap.get(phase);

        // Get all entries for this question (ordered by creation time)
        const allEntries = questionConvs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Build conversation flow
        const conversationFlow = [];
        let finalAnswer = '';

        allEntries.forEach(entry => {
          if (entry.message_type === 'bot' && entry.message_text) {
            conversationFlow.push({
              type: 'question',
              text: entry.message_text,
              timestamp: entry.created_at,
              is_followup: entry.is_followup || false
            });
          }
          if (entry.answer_text && entry.answer_text.trim() !== '') {
            conversationFlow.push({
              type: 'answer',
              text: entry.answer_text,
              timestamp: entry.created_at,
              is_followup: entry.is_followup || false
            });
            finalAnswer = entry.answer_text; // Keep track of the final answer
          }
        });

        // Check completion status
        const statusEntries = questionConvs.filter(c => c.metadata && c.metadata.is_complete !== undefined);
        const latestStatusEntry = statusEntries.length > 0
          ? statusEntries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
          : null;
        const isComplete = latestStatusEntry?.metadata?.is_complete || false;

        // Only add to phase if there are actual answers (completed questions)
        if (isComplete && finalAnswer) {
          phaseData.questions.push({
            question: question.question_text,
            answer: finalAnswer,
            question_id: question._id,
            conversation_flow: conversationFlow,
            is_complete: isComplete,
            last_updated: allEntries.length > 0 ? allEntries[allEntries.length - 1].created_at : null
          });
        }
      }
    });

    // Convert phase map to array and filter out empty phases
    const conversationPhases = Array.from(phaseMap.values()).filter(phase => phase.questions.length > 0);

    // Transform phase analysis into system format
    const systemAnalysis = phaseAnalysis.map(analysis => ({
      name: analysis.metadata?.analysis_type || 'unknown_analysis',
      analysis_result: analysis.analysis_result,
      created_at: analysis.created_at,
      phase: analysis.metadata?.phase,
      message_text: analysis.message_text
    }));

    // Calculate statistics
    const totalQuestions = questions.length;
    const completedQuestions = conversationPhases.reduce((sum, phase) => sum + phase.questions.length, 0);

    // Add question statistics to businesses
    const enhancedBusinesses = await Promise.all(
      businesses.map(async (business) => {
        // Get conversations for this specific business
        const businessConversations = await db.collection('user_business_conversations')
          .find({
            user_id: targetUserId,
            business_id: business._id,
            conversation_type: 'question_answer'
          })
          .toArray();

        // Calculate business-specific statistics
        const businessQuestionStats = {};

        businessConversations.forEach(conv => {
          if (conv.question_id) {
            const questionId = conv.question_id.toString();

            if (!businessQuestionStats[questionId]) {
              businessQuestionStats[questionId] = {
                hasAnswers: false,
                isComplete: false,
                answerCount: 0
              };
            }

            if (conv.answer_text && conv.answer_text.trim() !== '') {
              businessQuestionStats[questionId].hasAnswers = true;
              businessQuestionStats[questionId].answerCount++;
            }

            if (conv.metadata && conv.metadata.is_complete === true) {
              businessQuestionStats[questionId].isComplete = true;
            }
          }
        });

        const completedQuestionsForBusiness = Object.values(businessQuestionStats).filter(
          stat => stat.isComplete || stat.hasAnswers
        ).length;

        const progressPercentage = totalQuestions > 0
          ? Math.round((completedQuestionsForBusiness / totalQuestions) * 100)
          : 0;

        return {
          ...business,
          question_statistics: {
            total_questions: totalQuestions,
            completed_questions: completedQuestionsForBusiness,
            pending_questions: totalQuestions - completedQuestionsForBusiness,
            progress_percentage: progressPercentage,
            total_answers_given: Object.values(businessQuestionStats).reduce(
              (sum, stat) => sum + stat.answerCount, 0
            )
          }
        };
      })
    );

    const responseData = {
      user_info: {
        user_id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        created_at: targetUser.created_at
      },
      conversation: conversationPhases,
      system: systemAnalysis,
      businesses: enhancedBusinesses,
      stats: {
        total_questions: totalQuestions,
        completed_questions: completedQuestions,
        completion_percentage: totalQuestions > 0 ? Math.round((completedQuestions / totalQuestions) * 100) : 0,
        total_businesses: enhancedBusinesses.length,
        total_analyses: systemAnalysis.length
      },
      filter_info: {
        filtered_by_business: business_id ? true : false,
        business_id: business_id || null,
        showing_all_businesses: !business_id
      }
    };

    res.json(responseData);

  } catch (error) {
    console.error('Failed to fetch user data:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const {
      question_id,
      answer_text,
      is_followup = false,
      business_id,
      is_complete = false,
      is_skipped = false,
      metadata
    } = req.body;

    if (!question_id || (!answer_text && !is_skipped)) {
      return res.status(400).json({ error: 'Question ID and answer text (or skip) required' });
    }

    // Get question details for audit
    const question = await db.collection('global_questions').findOne({ _id: new ObjectId(question_id) });

    // Check if this is an edit from the brief section
    const isEdit = metadata?.from_editable_brief === true;

    if (isEdit && answer_text && answer_text.trim() !== '') {
      // For edits: Use UPSERT to ensure the answer is always saved
      const filter = {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        question_id: new ObjectId(question_id),
        conversation_type: 'question_answer'
      };

      const updateDoc = {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        question_id: new ObjectId(question_id),
        conversation_type: 'question_answer',
        message_type: 'user',
        message_text: '',
        answer_text: answer_text.trim(),
        is_followup: false,
        is_skipped: false,
        analysis_result: null,
        metadata: {
          ...metadata,
          is_complete: true,
          is_edit: true,
          last_edited: new Date()
        },
        attempt_count: 1,
        timestamp: new Date(),
        created_at: new Date(),
        updated_at: new Date()
      };

      // Use upsert to either update existing or create new
      const result = await db.collection('user_business_conversations')
        .replaceOne(filter, updateDoc, { upsert: true });

      // Log question edit
      await logAuditEvent(req.user._id, 'question_edited', {
        question_id,
        question_text: question?.question_text?.substring(0, 100) + '...',
        answer_preview: answer_text.substring(0, 200) + '...',
        operation: result.upsertedId ? 'created' : 'updated',
        upsert_id: result.upsertedId
      }, business_id);

      return res.json({
        message: 'Answer saved successfully',
        conversation_id: result.upsertedId || 'updated',
        is_complete: true,
        action: result.upsertedId ? 'created' : 'updated'
      });
    }

    // Original logic for new conversations (non-edit)
    const conversation = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'user',
      message_text: '',
      answer_text: answer_text || '',
      is_followup,
      is_skipped,
      analysis_result: null,
      metadata: {
        ...metadata,
        is_complete,
        is_skipped
      },
      attempt_count: 1,
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(conversation);

    // Log question answered or skipped
    const eventType = is_skipped ? 'question_skipped' : 'question_answered';
    await logAuditEvent(req.user._id, eventType, {
      question_id,
      question_text: question?.question_text?.substring(0, 100) + '...',
      answer_preview: answer_text ? answer_text.substring(0, 200) + '...' : 'N/A',
      is_followup
    }, business_id);

    res.json({
      message: is_skipped ? 'Question skipped' : 'Answer saved',
      conversation_id: result.insertedId,
      is_complete,
      is_skipped,
      action: 'created'
    });
  } catch (error) {
    console.error('Error saving conversation:', error);
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});
app.post('/api/conversations/skip', authenticateToken, async (req, res) => {
  try {
    const {
      question_id,
      business_id,
      metadata
    } = req.body;

    if (!question_id) {
      return res.status(400).json({ error: 'Question ID is required' });
    }

    // Validate that the question exists
    const question = await db.collection('global_questions').findOne({
      _id: new ObjectId(question_id)
    });

    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    // Create a conversation record for the skipped question
    const conversation = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'user',
      message_text: '',
      answer_text: '[Question Skipped]',
      is_followup: false,
      is_skipped: true,
      analysis_result: null,
      metadata: {
        ...metadata,
        is_complete: true, // Mark as complete since it's skipped
        is_skipped: true,
        skip_reason: 'user_skipped'
      },
      attempt_count: 1,
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(conversation);

    res.json({
      message: 'Question skipped successfully',
      conversation_id: result.insertedId,
      is_complete: true,
      is_skipped: true
    });
  } catch (error) {
    console.error('Failed to skip question:', error);
    res.status(500).json({ error: 'Failed to skip question' });
  }
});
// Save followup question generated by Groq
app.post('/api/conversations/followup-question', authenticateToken, async (req, res) => {
  try {
    const {
      question_id,
      followup_question_text,
      business_id,
      metadata
    } = req.body;

    if (!question_id || !followup_question_text) {
      return res.status(400).json({ error: 'Question ID and followup question text required' });
    }

    const conversation = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'bot',
      message_text: followup_question_text,
      answer_text: null,
      is_followup: true,
      analysis_result: null,
      metadata: metadata || {},
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(conversation);

    res.json({
      message: 'Followup question saved',
      conversation_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save followup question' });
  }
});
app.get('/api/phase-analysis/:phase', authenticateToken, async (req, res) => {
  try {
    const { phase } = req.params;
    const { business_id, analysis_type, user_id } = req.query;

    // Determine which user's phase analysis to fetch
    let targetUserId;

    if (user_id) {
      // Admin is requesting another user's phase analysis
      if (!['super_admin', 'company_admin'].includes(req.user.role.role_name)) {
        return res.status(403).json({ error: 'Admin access required to view other users phase analysis' });
      }

      const targetUser = await db.collection('users').findOne({ _id: new ObjectId(user_id) });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (req.user.role.role_name === 'company_admin') {
        if (!targetUser.company_id || targetUser.company_id.toString() !== req.user.company_id.toString()) {
          return res.status(403).json({ error: 'Access denied - user not in your company' });
        }
      }

      targetUserId = new ObjectId(user_id);
    } else {
      targetUserId = new ObjectId(req.user._id);
    }

    let filter = {
      user_id: targetUserId,
      conversation_type: 'phase_analysis',
      'metadata.phase': phase
    };

    if (business_id) filter.business_id = new ObjectId(business_id);
    if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

    const analysisResults = await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    const formattedResults = analysisResults.map(analysis => ({
      analysis_id: analysis._id,
      phase: analysis.metadata?.phase,
      analysis_type: analysis.metadata?.analysis_type,
      analysis_name: analysis.message_text,
      analysis_data: analysis.analysis_result,
      created_at: analysis.created_at
    }));

    // Group by analysis type
    const resultsByType = formattedResults.reduce((acc, result) => {
      const type = result.analysis_type || 'unknown';
      if (!acc[type]) {
        acc[type] = [];
      }
      acc[type].push(result);
      return acc;
    }, {});

    res.json({
      phase: phase,
      analysis_results: formattedResults,
      results_by_type: resultsByType,
      total_analyses: formattedResults.length,
      user_id: targetUserId.toString()
    });

  } catch (error) {
    console.error('Failed to fetch phase analysis:', error);
    res.status(500).json({ error: 'Failed to fetch phase analysis' });
  }
});
// Save phase analysis results (SWOT, Customer Segmentation, etc.)
app.post('/api/conversations/phase-analysis', authenticateToken, async (req, res) => {
  try {
    const {
      phase,
      analysis_type,
      analysis_name,
      analysis_data,
      business_id,
      metadata
    } = req.body;

    if (!phase || !analysis_type || !analysis_name || !analysis_data) {
      return res.status(400).json({ error: 'Phase, analysis type, name, and data are required' });
    }

    const enhancedMetadata = {
      phase: phase,
      analysis_type: analysis_type,
      generated_at: new Date().toISOString(),
      ...metadata
    };

    const phaseAnalysis = {
      user_id: new ObjectId(req.user._id),
      business_id: business_id ? new ObjectId(business_id) : null,
      question_id: null,
      conversation_type: 'phase_analysis',
      message_type: 'system',
      message_text: analysis_name,
      answer_text: null,
      is_followup: false,
      analysis_result: analysis_data,
      metadata: enhancedMetadata,
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations').updateOne(
      {
        user_id: new ObjectId(req.user._id),
        business_id: business_id ? new ObjectId(business_id) : null,
        conversation_type: 'phase_analysis',
        'metadata.phase': phase,
        'metadata.analysis_type': analysis_type
      },
      {
        $set: phaseAnalysis
      },
      { upsert: true }
    );

    // Enhanced audit logging with analysis result
    await logAuditEvent(req.user._id, 'analysis_generated', {
      analysis_type,
      analysis_name,
      phase,
      // Store the full analysis result in audit trail
      analysis_result: analysis_data,
      // Additional metadata for audit purposes
      metadata: {
        generated_at: new Date().toISOString(),
        was_update: result.upsertedId ? false : true,
        database_operation: result.upsertedId ? 'insert' : 'update',
        ...enhancedMetadata
      },
      // Store data size for monitoring
      data_size: JSON.stringify(analysis_data).length,
      // Store analysis summary for quick reference
      analysis_summary: {
        data_keys: Object.keys(analysis_data || {}),
        has_data: !!analysis_data,
        data_type: typeof analysis_data
      }
    }, business_id);

    res.json({
      message: 'Phase analysis saved',
      analysis_id: result.insertedId || 'updated',
      analysis_type: analysis_type,
      phase: phase
    });
  } catch (error) {
    console.error('Failed to save phase analysis:', error);
    res.status(500).json({ error: 'Failed to save phase analysis' });
  }
});


app.get('/api/admin/audit-trail', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, event_type, start_date, end_date, limit = 100, page = 1, include_analysis_data = false } = req.query;

    let filter = {};

    // Role-based filtering
    if (req.user.role.role_name === 'company_admin') {
      // Company admin can only see audit trail for users in their company
      const companyUsers = await db.collection('users')
        .find({ company_id: req.user.company_id })
        .project({ _id: 1 })
        .toArray();

      const userIds = companyUsers.map(u => u._id);
      filter.user_id = { $in: userIds };
    }

    // Additional filters
    if (user_id) {
      filter.user_id = new ObjectId(user_id);
    }

    if (event_type) {
      filter.event_type = event_type;
    }

    if (start_date || end_date) {
      filter.timestamp = {};
      if (start_date) filter.timestamp.$gte = new Date(start_date);
      if (end_date) filter.timestamp.$lte = new Date(end_date);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Define projection based on whether to include analysis data
    let projection = {
      event_type: 1,
      event_data: 1,
      timestamp: 1,
      additional_info: 1,
      user_name: '$user.name',
      user_email: '$user.email',
      company_name: '$company.company_name'
    };

    // If include_analysis_data is false, exclude large analysis_result from event_data
    if (include_analysis_data === 'false' || !include_analysis_data) {
      projection.event_data_summary = {
        $cond: {
          if: { $eq: ['$event_type', 'analysis_generated'] },
          then: {
            analysis_type: '$event_data.analysis_type',
            analysis_name: '$event_data.analysis_name',
            phase: '$event_data.phase',
            data_size: '$event_data.data_size',
            analysis_summary: '$event_data.analysis_summary',
            metadata: '$event_data.metadata',
            // Exclude analysis_result for summary view
            has_analysis_result: { $ne: ['$event_data.analysis_result', null] }
          },
          else: '$event_data'
        }
      };
      // Don't include full event_data for analysis_generated events
      projection.event_data = {
        $cond: {
          if: { $eq: ['$event_type', 'analysis_generated'] },
          then: '$$REMOVE',
          else: '$event_data'
        }
      };
    }

    // Get audit entries with user details
    const auditEntries = await db.collection('audit_trail').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'user.company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: projection
      },
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) }
    ]).toArray();

    // Get total count for pagination
    const totalCount = await db.collection('audit_trail').countDocuments(filter);

    // Get analysis generation statistics
    const analysisStats = await db.collection('audit_trail').aggregate([
      {
        $match: {
          ...filter,
          event_type: 'analysis_generated'
        }
      },
      {
        $group: {
          _id: '$event_data.analysis_type',
          count: { $sum: 1 },
          latest: { $max: '$timestamp' }
        }
      }
    ]).toArray();

    res.json({
      audit_entries: auditEntries,
      pagination: {
        total: totalCount,
        page: parseInt(page),
        limit: parseInt(limit),
        total_pages: Math.ceil(totalCount / parseInt(limit))
      },
      analysis_statistics: analysisStats,
      data_inclusion: {
        includes_full_analysis_data: include_analysis_data === 'true',
        note: include_analysis_data === 'true' ?
          'Full analysis results included - may be large' :
          'Analysis results summarized for performance'
      }
    });

  } catch (error) {
    console.error('Failed to fetch audit trail:', error);
    res.status(500).json({ error: 'Failed to fetch audit trail' });
  }
});

app.get('/api/admin/audit-trail/:audit_id/analysis-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { audit_id } = req.params;

    if (!ObjectId.isValid(audit_id)) {
      return res.status(400).json({ error: 'Invalid audit ID' });
    }

    const auditEntry = await db.collection('audit_trail').findOne({
      _id: new ObjectId(audit_id),
      event_type: 'analysis_generated'
    });

    if (!auditEntry) {
      return res.status(404).json({ error: 'Analysis audit entry not found' });
    }

    // Role-based access control
    if (req.user.role.role_name === 'company_admin') {
      const user = await db.collection('users').findOne({ _id: auditEntry.user_id });
      if (!user || user.company_id.toString() !== req.user.company_id.toString()) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    res.json({
      audit_id: auditEntry._id,
      timestamp: auditEntry.timestamp,
      analysis_result: auditEntry.event_data.analysis_result,
      analysis_metadata: {
        type: auditEntry.event_data.analysis_type,
        name: auditEntry.event_data.analysis_name,
        phase: auditEntry.event_data.phase,
        data_size: auditEntry.event_data.data_size
      }
    });

  } catch (error) {
    console.error('Failed to fetch analysis data from audit trail:', error);
    res.status(500).json({ error: 'Failed to fetch analysis data' });
  }
});
// Get audit event types for filtering
app.get('/api/admin/audit-trail/event-types', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const eventTypes = await db.collection('audit_trail').distinct('event_type');

    res.json({
      event_types: eventTypes.sort()
    });
  } catch (error) {
    console.error('Failed to fetch event types:', error);
    res.status(500).json({ error: 'Failed to fetch event types' });
  }
});

app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    // Log logout event
    await logAuditEvent(req.user._id, 'logout', {
      email: req.user.email
    });

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});
// Add API to mark question as complete/incomplete
app.put('/api/conversations/:question_id/status', authenticateToken, async (req, res) => {
  try {
    const { question_id } = req.params;
    const { completion_status, analysis_result } = req.body;

    if (!['complete', 'incomplete'].includes(completion_status)) {
      return res.status(400).json({ error: 'Status must be complete or incomplete' });
    }

    // Create a status update record
    const statusUpdate = {
      user_id: new ObjectId(req.user._id),
      question_id: new ObjectId(question_id),
      conversation_type: 'question_answer',
      message_type: 'system',
      message_text: `Question marked as ${completion_status}`,
      answer_text: null,
      is_followup: false,
      analysis_result: analysis_result || null,
      metadata: {
        is_complete: completion_status === 'complete',
        status_update: true
      },
      timestamp: new Date(),
      created_at: new Date()
    };

    const result = await db.collection('user_business_conversations')
      .insertOne(statusUpdate);

    res.json({
      message: `Question marked as ${completion_status}`,
      status_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.delete('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { business_id } = req.query;
    let filter = { user_id: new ObjectId(req.user._id) };

    if (business_id) {
      filter.business_id = new ObjectId(business_id);
    }

    const result = await db.collection('user_business_conversations')
      .deleteMany(filter);

    res.json({
      message: 'Conversations cleared',
      deleted_count: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear conversations' });
  }
});

// Get phase analysis results only
app.get('/api/phase-analysis', authenticateToken, async (req, res) => {
  try {
    const { phase, business_id, analysis_type } = req.query;

    let filter = {
      user_id: new ObjectId(req.user._id),
      conversation_type: 'phase_analysis'
    };

    if (business_id) filter.business_id = new ObjectId(business_id);
    if (phase) filter['metadata.phase'] = phase;
    if (analysis_type) filter['metadata.analysis_type'] = analysis_type;

    const analysisResults = await db.collection('user_business_conversations')
      .find(filter)
      .sort({ created_at: -1 })
      .toArray();

    const formattedResults = analysisResults.map(analysis => ({
      analysis_id: analysis._id,
      phase: analysis.metadata?.phase,
      analysis_type: analysis.metadata?.analysis_type,
      analysis_name: analysis.message_text,
      analysis_data: analysis.analysis_result,
      created_at: analysis.created_at
    }));

    // Group by phase
    const resultsByPhase = formattedResults.reduce((acc, result) => {
      const phase = result.phase || 'unknown';
      if (!acc[phase]) {
        acc[phase] = [];
      }
      acc[phase].push(result);
      return acc;
    }, {});

    res.json({
      analysis_results: formattedResults,
      results_by_phase: resultsByPhase,
      total_analyses: formattedResults.length
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch phase analysis' });
  }
});

// ===============================
// ADMIN APIs
// ===============================
app.get('/api/admin/companies', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let matchFilter = {};

    // Filter based on user role
    if (req.user.role.role_name === 'company_admin') {
      // Company admin can only see their own company
      if (!req.user.company_id) {
        return res.status(400).json({ error: 'No company associated with admin account' });
      }
      matchFilter._id = req.user.company_id;
    }
    // Super admin sees all companies (no filter needed)

    // Get companies with their admin details
    const companies = await db.collection('companies').aggregate([
      {
        $match: matchFilter
      },
      {
        $lookup: {
          from: 'users',
          let: { companyId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$company_id', '$$companyId'] },
                role_id: { $exists: true }
              }
            },
            {
              $lookup: {
                from: 'roles',
                localField: 'role_id',
                foreignField: '_id',
                as: 'role'
              }
            },
            {
              $unwind: '$role'
            },
            {
              $match: {
                'role.role_name': 'company_admin'
              }
            },
            {
              $limit: 1
            }
          ],
          as: 'admin'
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: 'company_id',
          as: 'users'
        }
      },
      {
        $addFields: {
          admin_name: { $arrayElemAt: ['$admin.name', 0] },
          admin_email: { $arrayElemAt: ['$admin.email', 0] },
          admin_created_at: { $arrayElemAt: ['$admin.created_at', 0] },
          total_users: { $size: '$users' },
          active_users: {
            $size: {
              $filter: {
                input: '$users',
                cond: { $ne: ['$$this.status', 'inactive'] }
              }
            }
          }
        }
      },
      {
        $project: {
          company_name: 1,
          industry: 1,
          size: 1,
          logo: 1,
          status: 1,
          created_at: 1,
          logo_updated_at: 1,
          admin_name: 1,
          admin_email: 1,
          admin_created_at: 1,
          total_users: 1,
          active_users: 1
        }
      },
      {
        $sort: { created_at: -1 }
      }
    ]).toArray();

    // If no admin found, set default values
    const enhancedCompanies = companies.map(company => ({
      ...company,
      admin_name: company.admin_name || 'No Admin Assigned',
      admin_email: company.admin_email || 'No Email',
      total_users: company.total_users || 0,
      active_users: company.active_users || 0
    }));

    res.json({
      companies: enhancedCompanies,
      total_count: enhancedCompanies.length,
      user_role: req.user.role.role_name,
      filtered_by_company: req.user.role.role_name === 'company_admin'
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.post('/api/admin/companies', authenticateToken, requireSuperAdmin, logoUpload.single('logo'), async (req, res) => {
  try {
    const { company_name, industry, size, admin_name, admin_email, admin_password } = req.body;

    if (!company_name || !admin_name || !admin_email || !admin_password) {
      return res.status(400).json({ error: 'Company name and admin details required' });
    }

    // Check if admin email exists
    const existingUser = await db.collection('users').findOne({ email: admin_email });
    if (existingUser) {
      return res.status(400).json({ error: 'Admin email already exists' });
    }

    // Handle logo if uploaded
    let logoUrl = null;
    if (req.file) {
      logoUrl = `${req.protocol}://${req.get('host')}/uploads/logos/${req.file.filename}`;
    }

    // Create company with logo
    const companyResult = await db.collection('companies').insertOne({
      company_name,
      industry: industry || '',
      size: size || '',
      logo: logoUrl,
      status: 'active',
      created_at: new Date(),
      logo_updated_at: logoUrl ? new Date() : null
    });

    // Create company admin
    const companyAdminRole = await db.collection('roles').findOne({ role_name: 'company_admin' });
    const hashedPassword = await bcrypt.hash(admin_password, 12);

    const adminResult = await db.collection('users').insertOne({
      name: admin_name,
      email: admin_email,
      password: hashedPassword,
      role_id: companyAdminRole._id,
      company_id: companyResult.insertedId,
      created_at: new Date()
    });

    res.json({
      message: 'Company and admin created successfully',
      company_id: companyResult.insertedId,
      admin_id: adminResult.insertedId,
      logo_url: logoUrl
    });

  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

app.post('/api/admin/questions', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { question_text, phase, severity, order, used_for, objective, required_info } = req.body;

    if (!question_text || !phase || !severity) {
      return res.status(400).json({ error: 'Question text, phase, and severity required' });
    }

    const result = await db.collection('global_questions').insertOne({
      question_text,
      phase,
      severity,
      order: order || 1,
      used_for: used_for || '',
      objective: objective || '',
      required_info: required_info || '',
      is_active: true,
      created_at: new Date()
    });

    res.json({
      message: 'Question created',
      question_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create question' });
  }
});

// Company Admin APIs
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { company_id } = req.query;
    let filter = {};

    // Handle company filtering based on user role
    if (req.user.role.role_name === 'company_admin') {
      // Company admin can only see users from their own company
      filter.company_id = req.user.company_id;
    } else if (req.user.role.role_name === 'super_admin') {
      // Super admin can filter by specific company if provided
      if (company_id) {
        try {
          filter.company_id = new ObjectId(company_id);
        } catch (error) {
          return res.status(400).json({ error: 'Invalid company ID format' });
        }
      }
      // If no company_id provided, show all users (no additional filter)
    }

    const users = await db.collection('users').aggregate([
      { $match: filter },
      {
        $lookup: {
          from: 'roles',
          localField: 'role_id',
          foreignField: '_id',
          as: 'role'
        }
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'company_id',
          foreignField: '_id',
          as: 'company'
        }
      },
      { $unwind: { path: '$role', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          email: 1,
          created_at: 1,
          role_name: '$role.role_name',
          company_name: '$company.company_name',
          company_id: 1 // Include company_id for debugging
        }
      },
      { $sort: { created_at: -1 } }
    ]).toArray();

    res.json({
      users,
      filter_applied: filter,
      total_count: users.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }

    const existingUser = await db.collection('users').findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    let companyId = req.user.company_id;
    if (req.user.role.role_name === 'super_admin' && req.body.company_id) {
      companyId = new ObjectId(req.body.company_id);
    }

    if (!companyId) {
      return res.status(400).json({ error: 'Company ID required' });
    }

    const userRole = await db.collection('roles').findOne({ role_name: 'user' });
    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await db.collection('users').insertOne({
      name,
      email,
      password: hashedPassword,
      role_id: userRole._id,
      company_id: companyId,
      created_at: new Date()
    });

    res.json({
      message: 'User created',
      user_id: result.insertedId
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/companies/:id/logo', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const companyId = req.params.id;
    const { logo } = req.body;

    if (!logo) {
      return res.status(400).json({ error: 'Logo is required' });
    }

    // Validate company access for company admin
    if (req.user.role.role_name === 'company_admin') {
      if (req.user.company_id.toString() !== companyId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const result = await db.collection('companies').updateOne(
      { _id: new ObjectId(companyId) },
      {
        $set: {
          logo: logo,
          logo_updated_at: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ message: 'Company logo updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update company logo' });
  }
});

const logAuditEvent = async (userId, eventType, eventData = {}, businessId = null) => {
  try {
    const auditEntry = {
      user_id: new ObjectId(userId),
      business_id: businessId ? new ObjectId(businessId) : null,
      event_type: eventType,
      event_data: eventData,
      timestamp: new Date(),
      ip_address: null, // Can be enhanced later
      user_agent: null  // Can be enhanced later
    };

    // For analysis_generated events, add additional tracking
    if (eventType === 'analysis_generated') {
      auditEntry.additional_info = {
        data_stored: true,
        analysis_phase: eventData.phase,
        analysis_type: eventData.analysis_type,
        logged_at: new Date().toISOString()
      };
    }

    await db.collection('audit_trail').insertOne(auditEntry);

    // Optional: Log successful audit entry for debugging
    console.log(`✅ Audit event logged: ${eventType} for user ${userId}`);

  } catch (error) {
    console.error('Failed to log audit event:', error);
    // Don't throw error to avoid breaking main functionality
  }
};

// ===============================
// HEALTH CHECK
// ===============================
app.get('/debug', async (req, res) => {
  try {
    res.json({
      env_mongo_uri: process.env.MONGO_URI ? 'SET' : 'NOT SET',
      used_mongo_uri: MONGO_URI.replace(/\/\/.*:.*@/, '//***:***@'),
      database_name: db ? db.databaseName : 'NOT CONNECTED',
      collections: db ? await db.listCollections().toArray() : []
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});
app.get('/health', async (req, res) => {
  try {
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
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Logo file size too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: `File upload error: ${error.message}` });
  }

  if (error.message.includes('Invalid file type')) {
    return res.status(400).json({ error: error.message });
  }

  next(error);
});

connectToMongoDB().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Traxxia API running on port ${port}`);
    console.log(`Server accessible at: http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});