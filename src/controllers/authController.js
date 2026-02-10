const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const { SECRET_KEY } = require('../config/constants');
const UserModel = require('../models/userModel');
const CompanyModel = require("../models/companyModel")
const { logAuditEvent } = require('../services/auditService');
const TierService = require('../services/tierService');

class AuthController {
  static async login(req, res) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      const user = await UserModel.findByEmail(email);
      if (!user || !await UserModel.comparePassword(password, user.password)) {
        if (user) {
          await logAuditEvent(user._id, 'login_failed', { email });
        }
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      const db = getDB();
      const role = await db.collection('roles').findOne({ _id: user.role_id });

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
      }, SECRET_KEY, { expiresIn: '24h' });

      await logAuditEvent(user._id, 'login_success', {
        email,
        role: role.role_name,
        company: company?.company_name
      });

      const planName = await TierService.getUserTier(user._id);

      res.json({
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: role.role_name,
          plan_name: planName,
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
  }

  static async register(req, res) {
    try {
      const { name, email, password, company_id, company_name, plan_id, terms_accepted } = req.body;

      if (!name || !email || !password || (!company_id && !company_name) || !terms_accepted) {
        return res.status(400).json({ error: 'All fields required including terms acceptance and company details' });
      }

      const existingUser = await UserModel.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: 'Email already exists' });
      }

      const db = getDB();
      let finalCompanyId;
      let finalRoleId;

      if (company_name) {
        // Handle new company creation
        const companyData = {
          company_name,
          company_name_normalized: company_name.toLowerCase().trim()
        };

        if (plan_id) {
          if (!ObjectId.isValid(plan_id)) {
            return res.status(400).json({ error: 'Invalid plan ID' });
          }
          companyData.plan_id = new ObjectId(plan_id);
        }

        finalCompanyId = await CompanyModel.create(companyData);

        const adminRole = await db.collection('roles').findOne({ role_name: 'company_admin' });
        finalRoleId = adminRole._id;
      } else {
        // Handle joining existing company
        const company = await db.collection('companies').findOne({
          _id: new ObjectId(company_id),
          status: 'active'
        });
        if (!company) {
          return res.status(400).json({ error: 'Invalid company' });
        }
        finalCompanyId = new ObjectId(company_id);

        const userRole = await db.collection('roles').findOne({ role_name: 'user' });
        finalRoleId = userRole._id;
      }

      const userId = await UserModel.create({
        name,
        email,
        password,
        role_id: finalRoleId,
        company_id: finalCompanyId,
        terms_accepted
      });

      res.json({
        message: 'Registration successful',
        user_id: userId,
        company_id: finalCompanyId
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  }


  static async logout(req, res) {
    try {
      await logAuditEvent(req.user._id, 'logout', {
        email: req.user.email
      });

      res.json({ message: 'Logged out successfully' });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Logout failed' });
    }
  }
}

module.exports = AuthController;