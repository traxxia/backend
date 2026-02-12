const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const { SECRET_KEY } = require('../config/constants');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('❌ No token provided');
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, SECRET_KEY, async (err, decoded) => {
    if (err) {
      console.log('❌ JWT verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid token' });
    }

    console.log('✅ JWT decoded successfully');
    console.log('Decoded user ID:', decoded.id);
    console.log('Decoded email:', decoded.email);
    console.log('Decoded role:', decoded.role);

    const db = getDB();
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

module.exports = { authenticateToken, requireAdmin, requireSuperAdmin };