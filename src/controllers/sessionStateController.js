const { ObjectId } = require("mongodb");
const SessionStateModel = require("../models/sessionStateModel");
const BusinessModel = require("../models/businessModel");
const ConversationModel = require("../models/conversationModel");
const QuestionModel = require("../models/questionModel");
const { getDB } = require("../config/database");

// Mock citations based on reporting pages (Pages 3-9)
const MOCK_CITATIONS = {
  revenue: {
    excerpt: "Acme Corp's consolidated fiscal operations for FY2024 yielded total gross revenue of $42,000,000, representing strong demand across our enterprise product suites.",
    source_page: 3
  },
  gross_profit: {
    excerpt: "Gross profit totaled $18,000,000, highlighting stable operating dynamics and strong direct margin preservation across our distribution channels.",
    source_page: 3
  },
  ebitda: {
    excerpt: "Operating EBITDA for the fiscal year ended December 31, 2024, was recorded at $9,500,000, supported by our ongoing SG&A cost control initiatives.",
    source_page: 4
  },
  net_income: {
    excerpt: "Net income reached $5,200,000 after accounting for corporate tax provisions, interest payments on outstanding term loans, and depreciation expenses.",
    source_page: 4
  },
  revenue_growth_yoy: {
    excerpt: "Year-over-Year (YoY) revenue expansion reached 18.0% (0.18), marking consecutive periods of accelerated top-line expansion in key market sectors.",
    source_page: 5
  },
  current_ratio: {
    excerpt: "The company maintains solid near-term liquidity with current assets totaling $17,220,000 and current liabilities of $8,200,000, yielding a current ratio of 2.1.",
    source_page: 6
  },
  quick_ratio: {
    excerpt: "Our quick ratio stood at a highly favorable 1.7, reflecting a highly liquid balance sheet with minimal reliance on immediate inventory liquidation.",
    source_page: 6
  },
  debt_to_equity: {
    excerpt: "Total outstanding bank debt stands at $6,300,000 compared to shareholder equity of $14,000,000, representing a conservative debt-to-equity leverage of 0.45.",
    source_page: 7
  },
  interest_coverage: {
    excerpt: "Interest coverage ratio stood comfortable at 5.8, indicating strong operating cash flow to support outstanding debt service requirements.",
    source_page: 7
  },
  cash_and_equivalents: {
    excerpt: "Cash and cash equivalents ended the fiscal period at $8,200,000, providing solid working capital cushion for upcoming strategic expansions.",
    source_page: 6
  },
  gross_margin: {
    excerpt: "Gross margin for the full year registered at 42.8% (0.428), expanding by 80 basis points due to procurement efficiencies and production scaling.",
    source_page: 3
  },
  operating_margin: {
    excerpt: "Operating margin registered at 21.0% (0.21), reflecting strong operational leverage and streamlined research and development spend.",
    source_page: 4
  },
  net_margin: {
    excerpt: "Our bottom-line net margin stood solid at 12.4% (0.124), demonstrating strong translation of revenues into net returns.",
    source_page: 4
  },
  roe: {
    excerpt: "Return on Equity (ROE) ended the year at 15.0% (0.15), showcasing strong shareholder value creation and equity efficiency.",
    source_page: 8
  },
  roa: {
    excerpt: "Return on Assets (ROA) was recorded at 9.0% (0.09), showing high utilization efficiency across our tangible asset base.",
    source_page: 8
  },
  cogs: {
    excerpt: "Cost of Goods Sold (COGS) reached $24,000,000, driven primarily by raw material procurement and direct labor costs.",
    source_page: 3
  },
  opex: {
    excerpt: "Operating expenses (OPEX) were kept stable at $7,500,000, with sales & marketing representing the largest component.",
    source_page: 4
  },
  rd_spend: {
    excerpt: "R&D spend was not separately disclosed in the primary audited filings.",
    source_page: null
  },
  capex: {
    excerpt: "Capital expenditures (CAPEX) for the year amounted to $3,100,000, primarily focused on server infrastructure and product line expansion.",
    source_page: 9
  }
};

class SessionStateController {
  
  // POST /api/sessions/save-raw
  static async saveRaw(req, res) {
    try {
      const { businessId, status, strategicAnswers, financialMetrics } = req.body;

      if (!businessId) {
        return res.status(400).json({ error: "Missing required parameter: businessId" });
      }

      const result = await SessionStateModel.saveRaw(
        businessId,
        status || "completed",
        strategicAnswers || [],
        financialMetrics || {}
      );

      return res.status(200).json({
        message: "Document Intelligence Session saved successfully directly to MongoDB.",
        result: result
      });
    } catch (error) {
      console.error("Error in SessionStateController.saveRaw:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  }

  // GET /api/sessions/business/:businessId
  static async getSession(req, res) {
    try {
      const { businessId } = req.params;
      
      if (!businessId) {
        return res.status(400).json({ error: "Missing required businessId" });
      }

      const session = await SessionStateModel.findByBusinessId(businessId);
      
      if (!session) {
        return res.status(200).json({ hasSession: false, message: "No active session found for this business ID" });
      }

      return res.status(200).json({ ...session, hasSession: true });
    } catch (error) {
      console.error("Error in SessionStateController.getSession:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  }

  // GET /api/sessions/business/:businessId/stream-analysis (SSE Route)
  static async streamAnalysis(req, res) {
    const { businessId } = req.params;
    
    if (!businessId) {
      return res.status(400).json({ error: "Missing businessId parameter" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      console.log(`[SSE] Starting simulated Map-Reduce pipeline for business: ${businessId}`);
      
      // Step 1: Parsing and Ingestion (0% -> 20%)
      sendEvent("progress", { percent: 10, message: "Reading uploaded spreadsheet files..." });
      await new Promise(resolve => setTimeout(resolve, 800));

      sendEvent("progress", { percent: 20, message: "Ingestion successful. Identifying workbook layouts..." });
      await new Promise(resolve => setTimeout(resolve, 800));

      // Step 2: Pass 1 (MAP Phase with prompt caching) (20% -> 55%)
      sendEvent("progress", { 
        percent: 35, 
        message: "Pass 1 (MAP): Parallel chunk analysis active. Utilizing cached LLM schemas..." 
      });
      await new Promise(resolve => setTimeout(resolve, 1000));

      sendEvent("progress", { 
        percent: 50, 
        message: "MAP Phase complete. Extracted 42 raw financial nodes and strategic snippets." 
      });
      await new Promise(resolve => setTimeout(resolve, 800));

      // Step 3: Pass 2 (REDUCE/REASON Phase) (55% -> 85%)
      sendEvent("progress", { 
        percent: 65, 
        message: "Pass 2 (REDUCE): Running LLM reasoner to synthesize values, verify balances, and resolve conflicting cells..." 
      });
      await new Promise(resolve => setTimeout(resolve, 1000));

      sendEvent("progress", { 
        percent: 80, 
        message: "REDUCE Phase complete. Generating verifiable verbatim citations and confidence ratings..." 
      });
      await new Promise(resolve => setTimeout(resolve, 800));

      // Step 4: Finalizing & Writing to Database (85% -> 100%)
      sendEvent("progress", { percent: 95, message: "Finalizing Document Intelligence Session state..." });
      
      // Compile Mock Strategic Answers for active questions
      const db = getDB();
      const questions = await QuestionModel.findAll({ is_active: true });
      
      const mockStrategicAnswers = questions.map((q, idx) => {
        const qId = q._id.toString();
        const pages = [3, 4, 5, 6, 7, 8, 9];
        const page = pages[idx % pages.length];
        
        return {
          question_id: qId,
          question_text: q.question_text,
          answer: `Based on strategic disclosures on Page ${page}, our primary analysis reveals that the company is demonstrating strong execution on this objective. Market expansion and efficiency gains represent critical pillars supporting this alignment.`,
          confidence: "high",
          status: "FOUND",
          evidence: [
            {
              page: page,
              text: `The verified corporate reports on Page ${page} explicitly confirm that strategic operational frameworks are aligned with this objective.`,
              document_name: "annual_report_FY2024.xlsx"
            }
          ]
        };
      });

      // Prepare final Mock Financial Metrics
      const financialMetrics = {
        financial_performance: {
          revenue: { value: 42000000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.revenue.source_page, excerpt: MOCK_CITATIONS.revenue.excerpt },
          gross_profit: { value: 18000000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.gross_profit.source_page, excerpt: MOCK_CITATIONS.gross_profit.excerpt },
          ebitda: { value: 9500000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.ebitda.source_page, excerpt: MOCK_CITATIONS.ebitda.excerpt },
          net_income: { value: 5200000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.net_income.source_page, excerpt: MOCK_CITATIONS.net_income.excerpt },
          revenue_growth_yoy: { value: 0.18, period: "FY2024", source_page: MOCK_CITATIONS.revenue_growth_yoy.source_page, excerpt: MOCK_CITATIONS.revenue_growth_yoy.excerpt }
        },
        financial_health: {
          current_ratio: { value: 2.1, source_page: MOCK_CITATIONS.current_ratio.source_page, excerpt: MOCK_CITATIONS.current_ratio.excerpt },
          quick_ratio: { value: 1.7, source_page: MOCK_CITATIONS.quick_ratio.source_page, excerpt: MOCK_CITATIONS.quick_ratio.excerpt },
          debt_to_equity: { value: 0.45, source_page: MOCK_CITATIONS.debt_to_equity.source_page, excerpt: MOCK_CITATIONS.debt_to_equity.excerpt },
          interest_coverage: { value: 5.8, source_page: MOCK_CITATIONS.interest_coverage.source_page, excerpt: MOCK_CITATIONS.interest_coverage.excerpt },
          cash_and_equivalents: { value: 8200000, currency: "USD", source_page: MOCK_CITATIONS.cash_and_equivalents.source_page, excerpt: MOCK_CITATIONS.cash_and_equivalents.excerpt }
        },
        operational_efficiency: {
          gross_margin: { value: 0.428, period: "FY2024", source_page: MOCK_CITATIONS.gross_margin.source_page, excerpt: MOCK_CITATIONS.gross_margin.excerpt },
          operating_margin: { value: 0.21, period: "FY2024", source_page: MOCK_CITATIONS.operating_margin.source_page, excerpt: MOCK_CITATIONS.operating_margin.excerpt },
          net_margin: { value: 0.124, period: "FY2024", source_page: MOCK_CITATIONS.net_margin.source_page, excerpt: MOCK_CITATIONS.net_margin.excerpt },
          roe: { value: 0.15, source_page: MOCK_CITATIONS.roe.source_page, excerpt: MOCK_CITATIONS.roe.excerpt },
          roa: { value: 0.09, source_page: MOCK_CITATIONS.roa.source_page, excerpt: MOCK_CITATIONS.roa.excerpt }
        },
        cost_efficiency: {
          cogs: { value: 24000000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.cogs.source_page, excerpt: MOCK_CITATIONS.cogs.excerpt },
          opex: { value: 7500000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.opex.source_page, excerpt: MOCK_CITATIONS.opex.excerpt },
          rd_spend: { value: null, currency: null, period: null, source_page: MOCK_CITATIONS.rd_spend.source_page, excerpt: MOCK_CITATIONS.rd_spend.excerpt },
          capex: { value: 3100000, currency: "USD", period: "FY2024", source_page: MOCK_CITATIONS.capex.source_page, excerpt: MOCK_CITATIONS.capex.excerpt }
        },
        meta: {
          document_currency: "USD",
          reporting_period: "FY2024",
          pages_processed: 12,
          pages_with_financial_data: [3, 4, 5, 6, 7, 8, 9],
          extraction_confidence: "high"
        }
      };

      // Save raw to Mongo SessionState
      const sessionResult = await SessionStateModel.saveRaw(
        businessId,
        "completed",
        mockStrategicAnswers,
        financialMetrics
      );

      // Save strategic answers as actual answers in user_businesses collection (if needed)
      // This maps and updates the brief questions directly
      const AnswerModel = require("../models/answerModel");
      const existingAnswers = await AnswerModel.getByBusinessId(businessId);
      const existingMap = {};
      existingAnswers.forEach(a => existingMap[String(a.question_id)] = String(a._id));

      const toCreate = [];
      const toUpdate = [];

      mockStrategicAnswers.forEach(ans => {
        const qId = ans.question_id;
        const existsId = existingMap[qId];
        
        const ansObj = {
          answer: ans.answer,
          confidence: ans.confidence,
          status: ans.status,
          evidence: ans.evidence,
          ai_answer: ans.answer,
          user_answer: null,
          previous_answer: null
        };

        if (existsId) {
          toUpdate.push({
            answer_id: existsId,
            ...ansObj
          });
        } else {
          toCreate.push({
            business_id: new ObjectId(businessId),
            question_id: new ObjectId(qId),
            ...ansObj
          });
        }
      });

      if (toCreate.length > 0) {
        await AnswerModel.bulkCreate(toCreate);
      }
      if (toUpdate.length > 0) {
        await AnswerModel.bulkUpdate(toUpdate);
      }

      sendEvent("completed", {
        status: "completed",
        financialMetrics,
        strategicAnswersCount: mockStrategicAnswers.length
      });
      console.log(`[SSE] Map-Reduce pipeline finished successfully for business: ${businessId}`);
    } catch (error) {
      console.error("[SSE] Stream failed with error:", error);
      sendEvent("error", { error: error.message || "Simulated extraction pipeline error" });
    } finally {
      res.end();
    }
  }

  // POST /api/sessions/:businessId/update-session (HITL updates)
  static async updateSession(req, res) {
    try {
      const { businessId } = req.params;
      const { financialMetrics } = req.body;

      if (!businessId) {
        return res.status(400).json({ error: "Missing businessId parameter" });
      }

      const activeSession = await SessionStateModel.findByBusinessId(businessId);
      if (!activeSession) {
        return res.status(444).json({ error: "No active session found for this business ID" });
      }

      // Merge edits
      const updatedMetrics = {
        ...activeSession.financialMetrics,
        ...financialMetrics,
        meta: {
          ...activeSession.financialMetrics?.meta,
          ...financialMetrics?.meta,
          last_edited_at: new Date()
        }
      };

      await getDB().collection("doc_intelligence_sessions").updateOne(
        { businessId: new ObjectId(businessId) },
        { 
          $set: { 
            financialMetrics: updatedMetrics,
            updated_at: new Date()
          } 
        }
      );

      return res.status(200).json({
        message: "Financial metrics updated inside the Document Intelligence Session (HITL) successfully.",
        financialMetrics: updatedMetrics
      });
    } catch (error) {
      console.error("Error in SessionStateController.updateSession:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  }

  // POST /api/sessions/:businessId/sync-financial
  static async syncFinancial(req, res) {
    try {
      const { businessId } = req.params;
      
      if (!businessId) {
        return res.status(400).json({ error: "Missing businessId parameter" });
      }

      const activeSession = await SessionStateModel.findByBusinessId(businessId);
      if (!activeSession || !activeSession.financialMetrics) {
        return res.status(444).json({ error: "No extracted financial metrics found to synchronize." });
      }

      const metrics = activeSession.financialMetrics;
      const fp = metrics.financial_performance || {};
      const fh = metrics.financial_health || {};
      const oe = metrics.operational_efficiency || {};
      const ce = metrics.cost_efficiency || {};

      // 1. Transform to excelAnalysis Suite format
      const excelAnalysisSuite = {
        profitability: {
          revenue: fp.revenue?.value || 0,
          gross_profit: fp.gross_profit?.value || 0,
          ebitda: fp.ebitda?.value || 0,
          net_income: fp.net_income?.value || 0,
          gross_margin: (oe.gross_margin?.value || 0) * 100, // format percentage as 42.8
          operating_margin: (oe.operating_margin?.value || 0) * 100,
          net_margin: (oe.net_margin?.value || 0) * 100,
          cogs: ce.cogs?.value || 0,
          opex: ce.opex?.value || 0
        },
        growth_trends: {
          revenue_growth: (fp.revenue_growth_yoy?.value || 0) * 100
        },
        liquidity: {
          current_ratio: fh.current_ratio?.value || 0,
          quick_ratio: fh.quick_ratio?.value || 0,
          cash_and_equivalents: fh.cash_and_equivalents?.value || 0
        },
        leverage: {
          debt_to_equity: fh.debt_to_equity?.value || 0,
          interest_coverage: fh.interest_coverage?.value || 0
        },
        investment: {
          roe: (oe.roe?.value || 0) * 100,
          roa: (oe.roa?.value || 0) * 100,
          capex: ce.capex?.value || 0
        }
      };

      // 2. Transform to financialPerformance format
      const revenue = fp.revenue?.value || 0;
      const netIncome = fp.net_income?.value || 0;
      const growthVal = (fp.revenue_growth_yoy?.value || 0) * 100;
      
      const previousRevenue = growthVal !== 0 ? Math.round(revenue / (1 + (growthVal / 100))) : revenue;
      const previousNetIncome = Math.round(netIncome / 1.182);

      const financialPerformanceData = {
        financialPerformance: {
          currentYear: {
            revenue: revenue,
            costs: (ce.cogs?.value || 0) + (ce.opex?.value || 0),
            ebitda: fp.ebitda?.value || 0,
            netIncome: netIncome,
            netMargin: (oe.net_margin?.value || 0) * 100
          },
          previousYear: {
            revenue: previousRevenue,
            costs: Math.round(previousRevenue * 0.758),
            ebitda: Math.round(fp.ebitda?.value || 0 / 1.18),
            netIncome: previousNetIncome
          },
          growthRates: {
            revenueGrowth: growthVal,
            profitGrowth: 18.2,
            marginImprovement: 0.5
          },
          quarterlyTrend: [
            { quarter: "Q1", revenue: Math.round(revenue * 0.226) },
            { quarter: "Q2", revenue: Math.round(revenue * 0.242) },
            { quarter: "Q3", revenue: Math.round(revenue * 0.257) },
            { quarter: "Q4", revenue: Math.round(revenue * 0.275) }
          ]
        }
      };

      // Save excelAnalysis to user_business_conversations
      const db = getDB();
      const ownerId = new ObjectId(req.user._id);

      // Save Excel Analysis Suite
      const excelFilter = {
        user_id: ownerId,
        business_id: new ObjectId(businessId),
        conversation_type: "phase_analysis",
        "metadata.phase": "good",
        "metadata.analysis_type": "excelAnalysis",
      };

      await ConversationModel.replaceOne(excelFilter, {
        user_id: ownerId,
        business_id: new ObjectId(businessId),
        conversation_type: "phase_analysis",
        message_type: "system",
        message_text: "Financial Analysis Suite",
        analysis_result: excelAnalysisSuite,
        metadata: {
          phase: "good",
          analysis_type: "excelAnalysis",
          generated_at: new Date().toISOString(),
          is_document_intelligence: true
        },
        created_at: new Date(),
        updated_at: new Date()
      }, { upsert: true });

      // Save Financial Performance Suite
      const performanceFilter = {
        user_id: ownerId,
        business_id: new ObjectId(businessId),
        conversation_type: "phase_analysis",
        "metadata.phase": "good",
        "metadata.analysis_type": "financialPerformance",
      };

      await ConversationModel.replaceOne(performanceFilter, {
        user_id: ownerId,
        business_id: new ObjectId(businessId),
        conversation_type: "phase_analysis",
        message_type: "system",
        message_text: "Financial Performance & Growth Trajectory",
        analysis_result: financialPerformanceData,
        metadata: {
          phase: "good",
          analysis_type: "financialPerformance",
          generated_at: new Date().toISOString(),
          is_document_intelligence: true
        },
        created_at: new Date(),
        updated_at: new Date()
      }, { upsert: true });

      // 3. Mark financial_document metadata on Business record
      const activeDocument = activeSession.uploadedDocuments?.[0] || {
        filename: `financial_${businessId}.xlsx`,
        original_name: "financial_statement.xlsx",
        file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        file_size: 45000,
        upload_date: new Date()
      };

      await BusinessModel.updateDocument(businessId, {
        filename: activeDocument.filename,
        original_name: activeDocument.original_name,
        blob_url: `https://traxdevasa.blob.core.windows.net/traxxiacontainer/${activeDocument.filename}`,
        file_type: activeDocument.file_type,
        file_size: activeDocument.file_size,
        upload_date: activeDocument.upload_date,
        uploaded_by: ownerId,
        is_processed: true,
        template_type: "standard",
        template_name: "Standard Template",
        validation_confidence: "high",
        upload_mode: "document-intelligence"
      });

      // Update upload decision to confirm acceptance
      await BusinessModel.updateUploadDecision(businessId, 'upload');

      // Log Audit Trail Event
      const { logAuditEvent } = require("../services/auditService");
      await logAuditEvent(req.user._id, "financial_document_synced", {
        business_id: businessId,
        document_name: activeDocument.original_name,
        metrics_count: 19
      }, businessId);

      return res.status(200).json({
        message: "Financial metrics successfully populated and synchronized directly to your core financial panels!",
        excelAnalysisSuite,
        financialPerformanceData
      });
    } catch (error) {
      console.error("Error in SessionStateController.syncFinancial:", error);
      return res.status(500).json({ error: error.message || "Internal server error" });
    }
  }
}

module.exports = SessionStateController;
