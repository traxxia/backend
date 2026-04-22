const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const { SECRET_KEY } = require('../config/constants');
const cacheUtil = require('../utils/cache');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, SECRET_KEY, async (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    try {
      const db = getDB();
      // Optimized: Use aggregate to fetch user and role in one hop
      const userData = await db.collection('users').aggregate([
        { $match: { _id: new ObjectId(decoded.id) } },
        {
          $lookup: {
            from: 'roles',
            localField: 'role_id',
            foreignField: '_id',
            as: 'role'
          }
        },
        { $unwind: { path: '$role', preserveNullAndEmptyArrays: true } }
      ]).toArray();

      const user = userData[0];

      if (!user) {
        return res.status(403).json({ error: 'User not found' });
      }

      req.user = user;
      next();
    } catch (dbErr) {
      console.error('Auth Database Error:', dbErr);
      res.status(500).json({ error: 'Authentication failed' });
    }
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