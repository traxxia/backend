const { ObjectId } = require('mongodb');
const CompanyModel = require('../models/companyModel');
const UserModel = require('../models/userModel');

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
}

module.exports = CompanyController;