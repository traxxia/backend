const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/database');
const { SECRET_KEY } = require('../config/constants');
const UserModel = require('../models/userModel');
const CompanyModel = require("../models/companyModel")
const { logAuditEvent } = require('../services/auditService');
const TierService = require('../services/tierService');
const StripeService = require('../services/stripeService');

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

      if (
        (user.status === 'inactive' && user.inactive_reason === 'plan_downgrade') ||
        user.access_mode === 'archived'
      ) {
        return res.status(403).json({
          error: 'Your plan is expired contact your admin for more',
          code: 'PLAN_EXPIRED'
        });
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

      await logAuditEvent(user._id, 'login_success', {
        email,
        role: role.role_name,
        company: company?.company_name
      });

      const planName = await TierService.getUserTier(user._id);
      // Use snapshotted limits so the JWT reflects the customer's purchased plan,
      // not the live plan that may have been edited by a super admin.
      const planLimits = user.company_id
        ? await TierService.getCompanyLimits(user.company_id)
        : await TierService.getTierLimits(planName);

      const token = jwt.sign({
        id: user._id,
        email: user.email,
        role: role.role_name,
        limits: {
          insight:   planLimits.insight   ?? false,
          strategic: planLimits.strategic ?? false,
          pmf:       planLimits.pmf       ?? false,
          project:   planLimits.project   ?? false,
        }
      }, SECRET_KEY, { expiresIn: '24h' });
      res.json({
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: role.role_name,
          plan_name: planName,
          limits: planLimits,
          company: company ? {
            id: company._id,
            name: company.company_name,
            logo: (company.logo && company.logo.includes('blob.core.windows.net'))
              ? `/api/admin/companies/${company._id}/logo/display`
              : company.logo,
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
      const { name, email, password, company_id, company_name, plan_id, terms_accepted, paymentMethodId } = req.body;

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
            company_name_normalized: company_name.toLowerCase().trim(),
            subscription_plan_price: 0 // Default to 0
          };

        if (plan_id) {
          if (!ObjectId.isValid(plan_id)) {
            return res.status(400).json({ error: 'Invalid plan ID' });
          }
          companyData.plan_id = new ObjectId(plan_id);

          // Build snapshot of the initial plan limits
          const planDoc = await db.collection('plans').findOne({ _id: companyData.plan_id });
          if (planDoc) {
            companyData.plan_snapshot = TierService.buildPlanSnapshot(planDoc);
          }

          // Payment Processing
          if (paymentMethodId) { // Check if payment method is provided
            try {
              if (planDoc && planDoc.stripe_price_id) {
                // Always save card and set as default for subscriptions
                const shouldSaveCard = true;

                const customer = await StripeService.createCustomer(email, name, paymentMethodId, shouldSaveCard);

                // Pass paymentMethodId explicitly to subscription if it's not saved as default
                const subscription = await StripeService.createSubscription(
                  customer.id,
                  planDoc.stripe_price_id,
                  null // Default payment method is already set on customer
                );

                companyData.stripe_customer_id = customer.id;
                companyData.stripe_subscription_id = subscription.id;
                companyData.stripe_payment_method_id = paymentMethodId;
                companyData.subscription_status = subscription.status;
                companyData.subscription_plan = planDoc.name; // Store plan name for easier logging later

                // Track start and end dates from Stripe
                companyData.subscription_start_date = subscription.current_period_start
                  ? new Date(subscription.current_period_start * 1000)
                  : new Date();

                companyData.subscription_end_date = subscription.current_period_end
                  ? new Date(subscription.current_period_end * 1000)
                  : (() => {
                    const d = new Date();
                    d.setMonth(d.getMonth() + 1);
                    return d;
                  })();

                const registrationAmount = planDoc.price || planDoc.price_usd || 0;
                companyData.subscription_plan_price = registrationAmount;

                await db.collection('billing_history').insertOne({
                  stripe_subscription_id: subscription.id,
                  amount: registrationAmount,
                  currency: 'usd',
                  date: new Date(),
                  type: 'initial_payment',
                  plan_name: planDoc.name
                  // We'll add company_id below once we have it
                });
              } else {
                console.warn('Plan does not have a stripe_price_id, skipping Stripe subscription creation.');
              }
            } catch (stripeError) {
              console.error('Stripe payment failed:', stripeError);
              return res.status(400).json({ error: 'Payment failed: ' + stripeError.message });
            }
          }
        }

        finalCompanyId = await CompanyModel.create(companyData);

        // Update the initial billing history with the company_id
        if (companyData.stripe_subscription_id) {
          await db.collection('billing_history').updateOne(
            { stripe_subscription_id: companyData.stripe_subscription_id, company_id: { $exists: false } },
            { $set: { company_id: finalCompanyId } }
          );
        }

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

  static async checkEmail(req, res) {
    try {
      const { email } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Valid email is required' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Valid email is required' });
      }

      const existingUser = await UserModel.findByEmail(email);

      if (existingUser) {
        return res.status(409).json({ error: 'Email is already in use' });
      }

      return res.status(200).json({ message: 'Email is available', available: true });
    } catch (error) {
      console.error('Check email error:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
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