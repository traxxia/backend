const { getDB } = require('../config/database');

class SystemSettingsModel {
  static async getLLMModelSettings() {
    const db = getDB();
    const doc = await db.collection('app_settings').findOne({ key: 'llm_model_settings' });
    if (!doc) {
      return {
        pmfFlow: 'gpt-4o-mini',
        enrichment: 'gpt-4o-mini',
        documentQa: 'gpt-oss-120b',
        simpleSwot: 'gpt-oss-120b',
        purchaseCriteria: 'gpt-4o',
        loyaltyNps: 'gpt-4o',
        expandedCapability: 'gpt-4o',
        strategicRadar: 'gpt-4o',
        maturityScoring: 'gpt-4o',
        competitiveAdvantage: 'gpt-4o',
        strategicPositioning: 'gpt-oss-120b',
        productivityMetrics: 'gpt-oss-120b',
        coreAdjacency: 'gpt-oss-120b'
      };
    }
    return {
      pmfFlow: doc.pmfFlow || 'gpt-4o-mini',
      enrichment: doc.enrichment || 'gpt-4o-mini',
      documentQa: doc.documentQa || 'gpt-oss-120b',
      simpleSwot: doc.simpleSwot || 'gpt-oss-120b',
      purchaseCriteria: doc.purchaseCriteria || 'gpt-4o',
      loyaltyNps: doc.loyaltyNps || 'gpt-4o',
      expandedCapability: doc.expandedCapability || 'gpt-4o',
      strategicRadar: doc.strategicRadar || 'gpt-4o',
      maturityScoring: doc.maturityScoring || 'gpt-4o',
      competitiveAdvantage: doc.competitiveAdvantage || 'gpt-4o',
      strategicPositioning: doc.strategicPositioning || 'gpt-oss-120b',
      productivityMetrics: doc.productivityMetrics || 'gpt-oss-120b',
      coreAdjacency: doc.coreAdjacency || 'gpt-oss-120b'
    };
  }

  static async saveLLMModelSettings(settings) {
    const db = getDB();
    return await db.collection('app_settings').updateOne(
      { key: 'llm_model_settings' },
      {
        $set: {
          pmfFlow: settings.pmfFlow || 'gpt-4o-mini',
          enrichment: settings.enrichment || 'gpt-4o-mini',
          documentQa: settings.documentQa || 'gpt-oss-120b',
          simpleSwot: settings.simpleSwot || 'gpt-oss-120b',
          purchaseCriteria: settings.purchaseCriteria || 'gpt-4o',
          loyaltyNps: settings.loyaltyNps || 'gpt-4o',
          expandedCapability: settings.expandedCapability || 'gpt-4o',
          strategicRadar: settings.strategicRadar || 'gpt-4o',
          maturityScoring: settings.maturityScoring || 'gpt-4o',
          competitiveAdvantage: settings.competitiveAdvantage || 'gpt-4o',
          strategicPositioning: settings.strategicPositioning || 'gpt-oss-120b',
          productivityMetrics: settings.productivityMetrics || 'gpt-oss-120b',
          coreAdjacency: settings.coreAdjacency || 'gpt-oss-120b',
          updated_at: new Date()
        }
      },
      { upsert: true }
    );
  }
}

module.exports = SystemSettingsModel;
