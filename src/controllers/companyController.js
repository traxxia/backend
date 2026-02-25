const { ObjectId } = require('mongodb');
const CompanyModel = require('../models/companyModel');
const UserModel = require('../models/userModel');
const BusinessModel = require('../models/businessModel');

class CompanyController {
  static async getAll(req, res) {
    try {
      const companies = await CompanyModel.findActive();
      res.json({ companies });
    } catch (error) {
      console.error('Failed to fetch companies:', error);
      res.status(500).json({ error: 'Failed to fetch companies' });
    }
  }

  static async updateLogo(req, res) {
    try {
      const companyId = req.params.id;
      const { logo } = req.body;

      if (!logo) {
        return res.status(400).json({ error: 'Logo is required' });
      }

      if (req.user.role.role_name === 'company_admin') {
        if (req.user.company_id.toString() !== companyId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const result = await CompanyModel.updateLogo(companyId, logo);

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Company not found' });
      }

      res.json({ message: 'Company logo updated successfully' });
    } catch (error) {
      console.error('Failed to update logo:', error);
      res.status(500).json({ error: 'Failed to update company logo' });
    }
  }

  static async getAITokenUsage(req, res) {
    try {
      const { business_id } = req.params;

      if (!business_id) {
        return res.status(400).json({ error: 'business_id is required' });
      }

      // 1. Find the business to get the user_id
      const business = await BusinessModel.findById(business_id);
      
      if (!business) {
        return res.status(404).json({ error: 'Business not found' });
      }

      // 2. Find the user to get the company_id
      const user = await UserModel.findById(business.user_id);

      if (!user || !user.company_id) {
        return res.status(404).json({ error: 'User or Company associated with business not found' });
      }

      // 3. Get the company's AI token usage
      const result = await CompanyModel.getAITokenUsage(user.company_id);
      
      res.json(result);
    } catch (error) {
      console.error('Failed to get AI token usage:', error);
      res.status(500).json({ error: 'Failed to get AI token usage' });
    }
  }

  static async updateAITokenUsage(req, res) {
    try {
      const { business_id, tokens_used } = req.body;

      if (!business_id || tokens_used === undefined) {
        return res.status(400).json({ error: 'business_id and tokens_used are required' });
      }

      // 1. Find the business to get the user_id
      const business = await BusinessModel.findById(business_id);
      
      if (!business) {
        return res.status(404).json({ error: 'Business not found' });
      }

      // 2. Find the user to get the company_id
      const user = await UserModel.findById(business.user_id);

      if (!user || !user.company_id) {
        return res.status(404).json({ error: 'User or Company associated with business not found' });
      }

      // 3. Update the company's AI token usage
      const result = await CompanyModel.updateAITokenUsage(user.company_id, tokens_used);
      
      res.json(result);
    } catch (error) {
      console.error('Failed to update AI token usage:', error);
      res.status(500).json({ error: 'Failed to update AI token usage' });
    }
  }
}

module.exports = CompanyController;