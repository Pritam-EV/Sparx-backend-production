// routes/ownerSettlements.js

const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const User = require("../models/User");
const Receipt = require("../models/Receipt");
const OwnerSettlement = require("../models/OwnerSettlement");

const router = express.Router();

router.use(
  authMiddleware,
  authorizeRoles("admin", "accountant")
);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SETTLEMENT_RECEIPTS = 2500;

const SETTLEMENT_STATUSES = [
  "pending",
  "processing",
  "paid",
  "failed",
  "on_hold",
];

const PAYOUT_METHODS = [
  "NEFT",
  "IMPS",
  "RTGS",
  "UPI",
  "OTHER",
];

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function round3(value) {
  return Number((Number(value) || 0).toFixed(3));
}

function parseDateBoundary(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const input = value.trim();
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    const utcMidnight = Date.UTC(year, month - 1, day);
    const result = new Date(utcMidnight - IST_OFFSET_MS);
    const shifted = new Date(result.getTime() + IST_OFFSET_MS);

    if (
      shifted.getUTCFullYear() !== year ||
      shifted.getUTCMonth() !== month - 1 ||
      shifted.getUTCDate() !== day
    ) {
      return null;
    }

    return result;
  }

  const result = new Date(input);

  return Number.isNaN(result.getTime()) ? null : result;
}

function parseSettlementPeriod(fromValue, toValue) {
  const from = parseDateBoundary(fromValue);
  const to = parseDateBoundary(toValue);

  if (!from || !to) {
    return {
      error:
        "Both from and to dates are required. Use YYYY-MM-DD or valid ISO timestamps.",
    };
  }

  if (from >= to) {
    return {
      error: "The start date must be earlier than the exclusive end date.",
    };
  }

  if (to.getTime() - from.getTime() > 400 * DAY_MS) {
    return {
      error: "The settlement period cannot exceed 400 days.",
    };
  }

  return { from, to };
}

function makeSettlementId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  return `OS-${date}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function canTransition(fromStatus, toStatus) {
  const allowed = {
    pending: ["processing", "paid", "failed", "on_hold"],
    processing: ["paid", "failed", "on_hold"],
    on_hold: ["processing", "paid", "failed"],
    failed: ["processing", "on_hold", "paid"],
    paid: [],
  };

  return Boolean(allowed[fromStatus]?.includes(toStatus));
}

function shapeSettlement(settlement, includeLineItems = false) {
  const shaped = {
    settlementId: settlement.settlementId,

    owner: {
      id: settlement.ownerId?._id || settlement.ownerId,
      name: settlement.ownerName || "",
      email: settlement.ownerEmail || "",
      mobile: settlement.ownerMobile || "",
    },

    period: {
      from: settlement.periodStart,
      to: settlement.periodEnd,
      endIsExclusive: true,
    },

    status: settlement.status,

    receiptCount: settlement.receiptCount,
    totalEnergyKwh: round3(settlement.totalEnergyKwh),
    customerBillingsInclGst: round2(
      settlement.customerBillingsInclGst
    ),
    refundAmountSnapshot: round2(settlement.refundAmountSnapshot),

    payoutAmount: round2(settlement.payoutAmount),
    amountPaid: round2(settlement.amountPaid),

    payoutMethod: settlement.payoutMethod || null,
    paymentReference: settlement.paymentReference || "",
    paidAt: settlement.paidAt || null,

    failureReason: settlement.failureReason || "",
    notes: settlement.notes || "",

    createdAt: settlement.createdAt,
    updatedAt: settlement.updatedAt,
  };

  if (includeLineItems) {
    shaped.items = (settlement.lineItems || []).map((item) => ({
      receiptId: item.receiptId,
      sessionId: item.sessionId,
      deviceId: item.deviceId,
      receiptCreatedAt: item.receiptCreatedAt,
      energyKwh: round3(item.energyKwh),
      customerBillingsInclGst: round2(
        item.customerBillingsInclGst
      ),
      refundAmountSnapshot: round2(item.refundAmountSnapshot),
      payoutAmount: round2(item.payoutAmount),
    }));

    shaped.statusHistory = (settlement.statusHistory || []).map(
      (entry) => ({
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        changedByRole: entry.changedByRole,
        reason: entry.reason || "",
        paymentReference: entry.paymentReference || "",
        changedAt: entry.changedAt,
      })
    );
  }

  return shaped;
}

// GET /api/owner-settlements
// Optional: ?ownerId=...&status=pending&page=1&limit=25

router.get("/", async (req, res) => {
  try {
    const page = Math.max(
      1,
      parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25)
    );

    const filter = {};

    if (req.query.ownerId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.ownerId)) {
        return res.status(400).json({
          error: "Invalid ownerId.",
        });
      }

      filter.ownerId = new mongoose.Types.ObjectId(
        req.query.ownerId
      );
    }

    if (req.query.status) {
      const status = String(req.query.status).toLowerCase();

      if (!SETTLEMENT_STATUSES.includes(status)) {
        return res.status(400).json({
          error: "Invalid settlement status.",
        });
      }

      filter.status = status;
    }

    const period = parseSettlementPeriodIfProvided(
      req.query.from,
      req.query.to
    );

    if (period.error) {
      return res.status(400).json({
        error: period.error,
      });
    }

    if (period.from || period.to) {
      filter.createdAt = {};

      if (period.from) filter.createdAt.$gte = period.from;
      if (period.to) filter.createdAt.$lt = period.to;
    }

    const [documents, total] = await Promise.all([
      OwnerSettlement.find(filter)
        .select("-lineItems -statusHistory")
        .populate("ownerId", "name email mobile")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      OwnerSettlement.countDocuments(filter),
    ]);

    return res.status(200).json({
      items: documents.map((item) => shapeSettlement(item)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Owner settlement register error:", error);

    return res.status(500).json({
      error: "Could not fetch settlements.",
    });
  }
});

// Handles optional from/to filters for the register GET endpoint.
function parseSettlementPeriodIfProvided(fromValue, toValue) {
  if (!fromValue && !toValue) {
    return {};
  }

  if (!fromValue || !toValue) {
    return {
      error: "Provide both from and to when filtering by period.",
    };
  }

  return parseSettlementPeriod(fromValue, toValue);
}

// GET /api/owner-settlements/:settlementId

router.get("/:settlementId", async (req, res) => {
  try {
    const settlement = await OwnerSettlement.findOne({
      settlementId: String(req.params.settlementId || "").trim(),
    })
      .populate("ownerId", "name email mobile")
      .lean();

    if (!settlement) {
      return res.status(404).json({
        error: "Settlement not found.",
      });
    }

    return res.status(200).json({
      settlement: shapeSettlement(settlement, true),
    });
  } catch (error) {
    console.error("Owner settlement detail error:", error);

    return res.status(500).json({
      error: "Could not fetch settlement details.",
    });
  }
});

// POST /api/owner-settlements
//
// Body:
// {
//   "ownerId": "MongoDB User ObjectId",
//   "from": "2026-10-01",
//   "to": "2026-10-17",
//   "notes": "October 1–16 owner payout"
// }
//
// "to" is exclusive. Only Receipt.ownerPayout > 0 is included.

router.post("/", async (req, res) => {
  let dbSession;

  try {
    const actorId = req.user.userId;
    const { ownerId, from: fromValue, to: toValue } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(actorId)) {
      return res.status(400).json({
        error: "Invalid authenticated user ID.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({
        error: "A valid ownerId is required.",
      });
    }

    const period = parseSettlementPeriod(fromValue, toValue);

    if (period.error) {
      return res.status(400).json({
        error: period.error,
      });
    }

    // Explicit cutover prevents accidentally paying historic receipts
    // that may already have been settled outside this ledger.
    const ledgerStart = parseDateBoundary(
      process.env.OWNER_SETTLEMENT_LEDGER_START_DATE
    );

    if (!ledgerStart) {
      return res.status(503).json({
        error:
          "Settlement creation is disabled. Configure OWNER_SETTLEMENT_LEDGER_START_DATE in Render after reconciling historic payouts.",
      });
    }

    if (period.from < ledgerStart) {
      return res.status(400).json({
        error:
          "The selected period starts before the settlement ledger activation date.",
        ledgerStartDate: ledgerStart.toISOString(),
      });
    }

    const owner = await User.findOne({
      _id: ownerId,
      role: "owner",
    })
      .select("name email mobile")
      .lean();

    if (!owner) {
      return res.status(404).json({
        error: "Owner account not found.",
      });
    }

    const notes =
      typeof req.body.notes === "string"
        ? req.body.notes.trim()
        : "";

    if (notes.length > 1000) {
      return res.status(400).json({
        error: "Notes cannot exceed 1,000 characters.",
      });
    }

    const dbOwnerId = new mongoose.Types.ObjectId(ownerId);
    const createdBy = new mongoose.Types.ObjectId(actorId);

    const receiptFilter = {
      ownerId: dbOwnerId,
      createdAt: {
        $gte: period.from,
        $lt: period.to,
      },
      ownerPayout: { $gt: 0 },
    };

    if (
      typeof req.body.deviceId === "string" &&
      req.body.deviceId.trim()
    ) {
      receiptFilter.deviceId = req.body.deviceId.trim();
    }

    let outcome = {
      tooMany: false,
      noReceipts: false,
      allAlreadyIncluded: false,
      settlement: null,
      skippedAlreadyIncluded: 0,
    };

    dbSession = await mongoose.startSession();

    await dbSession.withTransaction(async () => {
      const receipts = await Receipt.find(receiptFilter)
        .select(
          "_id receiptId sessionId deviceId createdAt energyConsumed " +
          "totalAmount refundAmount ownerPayout"
        )
        .sort({ createdAt: 1, _id: 1 })
        .limit(MAX_SETTLEMENT_RECEIPTS + 1)
        .session(dbSession)
        .lean();

      if (receipts.length > MAX_SETTLEMENT_RECEIPTS) {
        outcome.tooMany = true;
        return;
      }

      if (!receipts.length) {
        outcome.noReceipts = true;
        return;
      }

      const receiptRecordIds = receipts.map((receipt) => receipt._id);

      const existingSettlements = await OwnerSettlement.find({
        "lineItems.receiptRecordId": {
          $in: receiptRecordIds,
        },
      })
        .select("lineItems.receiptRecordId")
        .session(dbSession)
        .lean();

      const alreadyIncluded = new Set(
        existingSettlements.flatMap((settlement) =>
          settlement.lineItems.map((item) =>
            String(item.receiptRecordId)
          )
        )
      );

      const eligible = receipts.filter(
        (receipt) => !alreadyIncluded.has(String(receipt._id))
      );

      outcome.skippedAlreadyIncluded =
        receipts.length - eligible.length;

      if (!eligible.length) {
        outcome.allAlreadyIncluded = true;
        return;
      }

      const lineItems = eligible.map((receipt) => ({
        receiptRecordId: receipt._id,
        receiptId: receipt.receiptId,
        sessionId: receipt.sessionId,
        deviceId: receipt.deviceId,
        receiptCreatedAt: receipt.createdAt,

        energyKwh: round3(receipt.energyConsumed),
        customerBillingsInclGst: round2(receipt.totalAmount),
        refundAmountSnapshot: round2(receipt.refundAmount),
        payoutAmount: round2(receipt.ownerPayout),
      }));

      const payoutAmount = round2(
        lineItems.reduce((sum, item) => sum + item.payoutAmount, 0)
      );

      if (payoutAmount <= 0) {
        outcome.noReceipts = true;
        return;
      }

      const settlementDocument = {
        settlementId: makeSettlementId(),

        ownerId: dbOwnerId,
        ownerName: owner.name || "",
        ownerEmail: owner.email || "",
        ownerMobile: owner.mobile || "",

        periodStart: period.from,
        periodEnd: period.to,

        status: "pending",
        lineItems,
        receiptCount: lineItems.length,

        totalEnergyKwh: round3(
          lineItems.reduce((sum, item) => sum + item.energyKwh, 0)
        ),

        customerBillingsInclGst: round2(
          lineItems.reduce(
            (sum, item) => sum + item.customerBillingsInclGst,
            0
          )
        ),

        refundAmountSnapshot: round2(
          lineItems.reduce(
            (sum, item) => sum + item.refundAmountSnapshot,
            0
          )
        ),

        payoutAmount,
        amountPaid: 0,
        payoutMethod: null,
        paymentReference: "",
        paidAt: null,
        failureReason: "",
        notes,

        createdBy,
        updatedBy: null,

        statusHistory: [
          {
            fromStatus: null,
            toStatus: "pending",
            changedBy: createdBy,
            changedByRole: req.user.role,
            reason: "Settlement batch created.",
            paymentReference: "",
            changedAt: new Date(),
          },
        ],
      };

      const [created] = await OwnerSettlement.create(
        [settlementDocument],
        { session: dbSession }
      );

      outcome.settlement = created;
    });

    if (outcome.tooMany) {
      return res.status(413).json({
        error:
          "More than 2,500 eligible receipts were found. Create smaller settlement periods.",
      });
    }

    if (outcome.noReceipts) {
      return res.status(400).json({
        error: "No positive owner-payout receipts were found for this period.",
      });
    }

    if (outcome.allAlreadyIncluded) {
      return res.status(409).json({
        error:
          "All eligible receipts have already been included in a settlement.",
        skippedAlreadyIncluded: outcome.skippedAlreadyIncluded,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Settlement batch created. No money was transferred by this API.",

      settlement: shapeSettlement(
        outcome.settlement.toObject(),
        true
      ),

      skippedAlreadyIncluded: outcome.skippedAlreadyIncluded,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        error:
          "One or more receipts were added to another settlement concurrently. Refresh the register and try again.",
      });
    }

    console.error("Owner settlement creation error:", error);

    return res.status(500).json({
      error: "Could not create settlement.",
    });
  } finally {
    if (dbSession) {
      await dbSession.endSession();
    }
  }
});

// PATCH /api/owner-settlements/:settlementId/status
//
// Body examples:
// { "status": "processing", "reason": "Bank transfer initiated" }
// { "status": "paid", "payoutMethod": "NEFT",
//   "paymentReference": "UTR123456789", "reason": "Transfer confirmed" }
// { "status": "failed", "reason": "Beneficiary account rejected" }

router.patch("/:settlementId/status", async (req, res) => {
  try {
    const actorId = req.user.userId;
    const nextStatus = String(req.body?.status || "")
      .trim()
      .toLowerCase();

    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim()
        : "";

    if (!mongoose.Types.ObjectId.isValid(actorId)) {
      return res.status(400).json({
        error: "Invalid authenticated user ID.",
      });
    }

    if (!SETTLEMENT_STATUSES.includes(nextStatus)) {
      return res.status(400).json({
        error: "Invalid settlement status.",
        allowedStatuses: SETTLEMENT_STATUSES,
      });
    }

    if (
      ["failed", "on_hold"].includes(nextStatus) &&
      (reason.length < 5 || reason.length > 500)
    ) {
      return res.status(400).json({
        error:
          "Provide a reason between 5 and 500 characters for failed or on-hold settlements.",
      });
    }

    if (reason.length > 500) {
  return res.status(400).json({
    error: "Reason cannot exceed 500 characters.",
  });
}

    let payoutMethod = null;
    let paymentReference = "";

    if (nextStatus === "paid") {
      payoutMethod = String(req.body?.payoutMethod || "")
        .trim()
        .toUpperCase();

      paymentReference = String(
        req.body?.paymentReference || ""
      ).trim();

      if (!PAYOUT_METHODS.includes(payoutMethod)) {
        return res.status(400).json({
          error: "A valid payoutMethod is required when marking paid.",
          allowedPayoutMethods: PAYOUT_METHODS,
        });
      }

      if (
        paymentReference.length < 3 ||
        paymentReference.length > 120
      ) {
        return res.status(400).json({
          error:
            "Provide a payment reference between 3 and 120 characters.",
        });
      }
    }

    const settlement = await OwnerSettlement.findOne({
      settlementId: String(req.params.settlementId || "").trim(),
    });

    if (!settlement) {
      return res.status(404).json({
        error: "Settlement not found.",
      });
    }

    const previousStatus = settlement.status;

    if (!canTransition(previousStatus, nextStatus)) {
      return res.status(409).json({
        error: `Settlement cannot transition from "${previousStatus}" to "${nextStatus}".`,
        currentStatus: previousStatus,
      });
    }

    const actorObjectId = new mongoose.Types.ObjectId(actorId);

    settlement.status = nextStatus;
    if (nextStatus !== "failed") {
  settlement.failureReason = "";
}
    settlement.updatedBy = actorObjectId;

    if (nextStatus === "paid") {
      // This is a manually recorded full payout; partial payments are
      // intentionally not supported by this ledger version.
      settlement.amountPaid = settlement.payoutAmount;
      settlement.payoutMethod = payoutMethod;
      settlement.paymentReference = paymentReference;
      settlement.paidAt = new Date();
      settlement.failureReason = "";
    }

    if (nextStatus === "failed") {
      settlement.failureReason = reason;
    }

    settlement.statusHistory.push({
      fromStatus: previousStatus,
      toStatus: nextStatus,
      changedBy: actorObjectId,
      changedByRole: req.user.role,
      reason,
      paymentReference: nextStatus === "paid" ? paymentReference : "",
      changedAt: new Date(),
    });

    await settlement.save();

    return res.status(200).json({
      success: true,
      message:
        nextStatus === "paid"
          ? "Payout recorded as paid. The bank transfer was not initiated by this API."
          : `Settlement status updated to ${nextStatus}.`,
      settlement: shapeSettlement(settlement.toObject()),
    });
  } catch (error) {
    if (error?.name === "VersionError") {
      return res.status(409).json({
        error:
          "This settlement was updated by another user. Refresh and try again.",
      });
    }

    console.error("Owner settlement status update error:", error);

    return res.status(500).json({
      error: "Could not update settlement status.",
    });
  }
});

module.exports = router;