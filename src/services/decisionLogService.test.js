const { ObjectId } = require("mongodb");

jest.mock("../models/decisionLogModel", () => ({
  create: jest.fn(),
  createIndexes: jest.fn(),
}));

jest.mock("./auditService", () => ({
  logAuditEvent: jest.fn(),
}));

const DecisionLogModel = require("../models/decisionLogModel");
const { logAuditEvent } = require("./auditService");
const DecisionLogService = require("./decisionLogService");

describe("DecisionLogService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("createManualDecisionLog writes decision log and audit event", async () => {
    const insertedId = new ObjectId();
    DecisionLogModel.create.mockResolvedValue(insertedId);

    const project = {
      _id: new ObjectId(),
      business_id: new ObjectId(),
      status: "Active",
      learning_state: "Testing",
    };

    const actorId = new ObjectId();
    const result = await DecisionLogService.createManualDecisionLog({
      project,
      actorId,
      logType: "manual",
      decision: "manual_decision",
      executionState: "Active",
      assumptionState: "Testing",
      justification: "Documenting manual decision",
    });

    expect(result).toEqual(insertedId);
    expect(DecisionLogModel.create).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  test("logProjectUpdateIfSignificant skips log when no tracked fields changed", async () => {
    const projectBefore = {
      _id: new ObjectId(),
      business_id: new ObjectId(),
      status: "Draft",
      learning_state: "Testing",
      updated_at: new Date(),
    };

    const result = await DecisionLogService.logProjectUpdateIfSignificant({
      projectBefore,
      updateData: { description: "non-significant change" },
      actorId: new ObjectId(),
      justification: "",
    });

    expect(result).toBeNull();
    expect(DecisionLogModel.create).not.toHaveBeenCalled();
  });
});
