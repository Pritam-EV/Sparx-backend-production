// routes/adminOwnerFinance.js
// Admin-only read access to an owner's monthly finance & settlement page.
// Response shape and calculations intentionally mirror routes/owner.js.

const express = require("express");
const mongoose = require("mongoose");

const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const User = require("../models/User");
const Device = require("../models/device");
const Receipt = require("../models/Receipt");
const OwnerSettlement = require("../models/OwnerSettlement");
const ElectricityBill = require("../models/ElectricityBill");

const router = express.Router();
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

router.use(authMiddleware, authorizeRoles("admin"));

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function round3(value) {
  return Number((Number(value) || 0).toFixed(3));
}

function getIstMonthStart(date) {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - IST_OFFSET_MS
  );
}

function getIstMonthKey(date) {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1
  ).padStart(2, "0")}`;
}

function getIstNextMonthStart(date) {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - IST_OFFSET_MS
  );
}

function monthKeyToRange(monthKey) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey);
  if (!match) return null;

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - IST_OFFSET_MS),
    to: new Date(Date.UTC(year, monthNumber, 1) - IST_OFFSET_MS),
  };
}

// GET /api/admin/owners/:ownerId/finance/monthly?month=YYYY-MM
router.get("/:ownerId/finance/monthly", async (req, res) => {
  try {
    const ownerId = String(req.params.ownerId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ error: "Invalid owner ID." });
    }

    // Do not allow this endpoint to be used to view customers or admins as owners.
    const owner = await User.findById(ownerId).select("_id name role").lean();
    if (!owner || owner.role !== "owner") {
      return res.status(404).json({ error: "Owner not found." });
    }

    const ownerObjectId = new mongoose.Types.ObjectId(ownerId);
    const ownedDevices = await Device.find({ ownerId: ownerObjectId })
      .select("device_id project commercial.electricityBearer")
      .lean();
    const deviceIds = ownedDevices.map((device) => device.device_id).filter(Boolean);

    const currentMonthStart = getIstMonthStart(new Date());
    const currentMonthKey = getIstMonthKey(currentMonthStart);
    const firstReceipt = deviceIds.length
      ? await Receipt.findOne({ deviceId: { $in: deviceIds } })
          .select("createdAt")
          .sort({ createdAt: 1 })
          .lean()
      : null;

    let earliestMonthStart = firstReceipt?.createdAt
      ? getIstMonthStart(new Date(firstReceipt.createdAt))
      : currentMonthStart;
    if (earliestMonthStart > currentMonthStart) earliestMonthStart = currentMonthStart;

    const earliestAvailableMonth = getIstMonthKey(earliestMonthStart);
    const availableMonths = [];
    let cursor = new Date(earliestMonthStart);
    while (cursor <= currentMonthStart) {
      availableMonths.push(getIstMonthKey(cursor));
      cursor = getIstNextMonthStart(cursor);
    }
    availableMonths.reverse();

    const month = typeof req.query.month === "string" && req.query.month.trim()
      ? req.query.month.trim()
      : currentMonthKey;

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: "Invalid month. Use YYYY-MM." });
    }
    if (month > currentMonthKey) {
      return res.status(400).json({ error: "Future months cannot be selected." });
    }
    if (month < earliestAvailableMonth) {
      return res.status(400).json({
        error: "The selected month is before the first available receipt month.",
        earliestAvailableMonth,
      });
    }

    const period = monthKeyToRange(month);
    if (!period) {
      return res.status(400).json({ error: "Could not determine the selected month." });
    }
    const { from, to } = period;

    const emptyReceipts = () => ({
      receiptCount: 0,
      energyConsumed: 0,
      taxableAmount: 0,
      gstAmount: 0,
      totalAmount: 0,
      vjraMarginAmount: 0,
      ownerPayout: 0,
      payoutEligibleReceiptCount: 0,
    });

    const aggregateReceipts = async (ids) => {
      if (!ids.length) return emptyReceipts();
      const [row] = await Receipt.aggregate([
        {
          $match: {
            deviceId: { $in: ids },
            createdAt: { $gte: from, $lt: to },
          },
        },
        {
          $group: {
            _id: null,
            receiptCount: { $sum: 1 },
            energyConsumed: { $sum: { $ifNull: ["$energyConsumed", 0] } },
            taxableAmount: { $sum: { $ifNull: ["$taxableAmount", 0] } },
            gstAmount: { $sum: { $ifNull: ["$gstAmount", 0] } },
            totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
            vjraMarginAmount: { $sum: { $ifNull: ["$vjraMarginAmount", 0] } },
            ownerPayout: { $sum: { $ifNull: ["$ownerPayout", 0] } },
            payoutEligibleReceiptCount: {
              $sum: {
                $cond: [{ $gt: [{ $ifNull: ["$ownerPayout", 0] }, 0] }, 1, 0],
              },
            },
          },
        },
      ]);

      if (!row) return emptyReceipts();
      return {
        receiptCount: Number(row.receiptCount || 0),
        energyConsumed: round3(row.energyConsumed),
        taxableAmount: round2(row.taxableAmount),
        gstAmount: round2(row.gstAmount),
        totalAmount: round2(row.totalAmount),
        vjraMarginAmount: round2(row.vjraMarginAmount),
        ownerPayout: round2(row.ownerPayout),
        payoutEligibleReceiptCount: Number(row.payoutEligibleReceiptCount || 0),
      };
    };

    // Same receipt aggregation as the owner page and Owner Overview.
    const allReceiptTotals = await aggregateReceipts(deviceIds);
    const isVjraBearer = (device) =>
      String(device.commercial?.electricityBearer || "OWNER").toUpperCase() === "VJRA";

    const ownerBearerDevices = ownedDevices.filter((device) => !isVjraBearer(device));
    const ownerBearerDeviceIds = ownerBearerDevices
      .map((device) => device.device_id)
      .filter(Boolean);
    const ownerBearerReceipts = await aggregateReceipts(ownerBearerDeviceIds);
    const ownerBearerPayout = round2(ownerBearerReceipts.ownerPayout);

    const vjraDevices = ownedDevices.filter(isVjraBearer);
    const electricityApplicable = vjraDevices.length > 0;
    const projectMap = new Map();

    for (const device of vjraDevices) {
      const projectName = String(device.project || "").trim();
      const projectKey = projectName || "__UNASSIGNED__";
      if (!projectMap.has(projectKey)) {
        projectMap.set(projectKey, {
          project: projectName || "Project not assigned",
          projectKey: projectName || null,
          deviceCount: 0,
        });
      }
      projectMap.get(projectKey).deviceCount += 1;
    }

    const vjraProjectRows = [...projectMap.values()];
    const validProjectNames = vjraProjectRows
      .map((row) => row.projectKey)
      .filter(Boolean);
    const billDocuments = validProjectNames.length
      ? await ElectricityBill.find({
          project: { $in: validProjectNames },
          month,
          isVoided: false,
        })
          .select(
            "project month status totalOwnerPayable totalEBAmount charges.energyCharges.amount " +
              "ownerPayment.submittedAt ownerPayment.verifiedAt"
          )
          .lean()
      : [];
    const billByProject = new Map(billDocuments.map((bill) => [bill.project, bill]));

    const electricityProjects = vjraProjectRows.map((projectRow) => {
      const bill = projectRow.projectKey
        ? billByProject.get(projectRow.projectKey)
        : null;

      if (!bill) {
        return {
          project: projectRow.project,
          deviceCount: projectRow.deviceCount,
          billGenerated: false,
          status: "not_generated",
          totalMsebBill: null,
          energyCharges: null,
          fixedElectricityCharges: null,
          ownerPayable: null,
          ownerPaymentVerified: false,
          canPay: false,
        };
      }

      const energyCharges = round2(bill.charges?.energyCharges?.amount);
      const fixedElectricityCharges = round2(bill.totalOwnerPayable);
      return {
        project: projectRow.project,
        deviceCount: projectRow.deviceCount,
        billGenerated: true,
        status: bill.status,
        totalMsebBill: round2(bill.totalEBAmount),
        energyCharges,
        fixedElectricityCharges,
        ownerPayable: fixedElectricityCharges,
        ownerPaymentVerified: ["payment_verified", "eb_paid_to_mseb"].includes(bill.status),
        canPay: bill.status === "uploaded",
        paymentSubmittedAt: bill.ownerPayment?.submittedAt || null,
        paymentVerifiedAt: bill.ownerPayment?.verifiedAt || null,
      };
    });

    const allVjraBillsGenerated = electricityApplicable &&
      electricityProjects.length > 0 &&
      electricityProjects.every((project) => project.billGenerated);

    const vjraTotals = allVjraBillsGenerated
      ? (() => {
          const billTotals = electricityProjects.reduce((totals, project) => ({
            energyCharges: round2(totals.energyCharges + project.energyCharges),
            fixedElectricityCharges: round2(
              totals.fixedElectricityCharges + project.fixedElectricityCharges
            ),
            totalMsebBill: round2(totals.totalMsebBill + project.totalMsebBill),
          }), {
            energyCharges: 0,
            fixedElectricityCharges: 0,
            totalMsebBill: 0,
          });

          const taxableAmount = round2(allReceiptTotals.taxableAmount);
          const vjraMarginAmount = round2(allReceiptTotals.vjraMarginAmount);
          const grossOwnerPayout = round2(
            taxableAmount - vjraMarginAmount - billTotals.energyCharges
          );
          const netOwnerPayout = round2(
            grossOwnerPayout - billTotals.fixedElectricityCharges
          );
          return {
            ...billTotals,
            taxableAmount,
            vjraMarginAmount,
            grossOwnerPayout,
            netOwnerPayout,
            netSettlement: netOwnerPayout,
          };
        })()
      : null;

    const settlementGroups = ownerBearerDeviceIds.length
      ? await OwnerSettlement.aggregate([
          {
            $match: {
              ownerId: ownerObjectId,
              "lineItems.receiptCreatedAt": { $gte: from, $lt: to },
            },
          },
          { $unwind: "$lineItems" },
          {
            $match: {
              "lineItems.receiptCreatedAt": { $gte: from, $lt: to },
              "lineItems.deviceId": { $in: ownerBearerDeviceIds },
              "lineItems.payoutAmount": { $gt: 0 },
            },
          },
          {
            $group: {
              _id: "$status",
              receiptCount: { $sum: 1 },
              payoutAmount: { $sum: { $ifNull: ["$lineItems.payoutAmount", 0] } },
            },
          },
        ])
      : [];

    const settlementSummary = settlementGroups.reduce((summary, row) => {
      const count = Number(row.receiptCount || 0);
      const amount = Number(row.payoutAmount || 0);
      summary.settledReceiptCount += count;
      summary.recordedPayoutAmount += amount;
      if (row._id === "paid") {
        summary.paidReceiptCount += count;
        summary.paidPayoutAmount += amount;
      }
      return summary;
    }, {
      settledReceiptCount: 0,
      recordedPayoutAmount: 0,
      paidReceiptCount: 0,
      paidPayoutAmount: 0,
    });

    const eligibleReceipts = ownerBearerReceipts.payoutEligibleReceiptCount;
    let payoutSettlementStatus = "not_applicable";
    if (eligibleReceipts > 0) {
      if (settlementSummary.paidReceiptCount >= eligibleReceipts) {
        payoutSettlementStatus = "paid";
      } else if (settlementSummary.paidReceiptCount > 0) {
        payoutSettlementStatus = "partially_paid";
      } else if (settlementSummary.settledReceiptCount > 0) {
        payoutSettlementStatus = "pending";
      } else {
        payoutSettlementStatus = "not_settled";
      }
    }

    return res.status(200).json({
      owner: {
        id: String(owner._id),
        name: owner.name || "",
      },
      month,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "Asia/Kolkata",
        endIsExclusive: true,
      },
      availableMonths,
      earliestAvailableMonth,
      totals: {
        receiptCount: allReceiptTotals.receiptCount,
        totalAmount: allReceiptTotals.totalAmount,
        taxableAmount: allReceiptTotals.taxableAmount,
        gstAmount: allReceiptTotals.gstAmount,
        vjraMarginAmount: allReceiptTotals.vjraMarginAmount,
        energyConsumed: allReceiptTotals.energyConsumed,
        ownerPayout: allReceiptTotals.ownerPayout,
        ownerBearerPayout,
        ownerBearerDeviceCount: ownerBearerDevices.length,
        vjraGrossOwnerPayout: vjraTotals ? vjraTotals.grossOwnerPayout : null,
        fixedElectricityCharges: vjraTotals ? vjraTotals.fixedElectricityCharges : null,
        vjraEnergyCharges: vjraTotals ? vjraTotals.energyCharges : null,
        netOwnerPayout: vjraTotals ? vjraTotals.netOwnerPayout : null,
        netSettlement: vjraTotals ? vjraTotals.netOwnerPayout : null,
        vjraSettlementAvailable: !electricityApplicable || allVjraBillsGenerated,
      },
      electricity: {
        applicable: electricityApplicable,
        allBillsGenerated: allVjraBillsGenerated,
        missingBillCount: electricityProjects.filter((project) => !project.billGenerated).length,
        projects: electricityProjects,
        totals: electricityApplicable ? vjraTotals : null,
      },
      payoutSettlement: {
        status: payoutSettlementStatus,
        eligibleReceiptCount: eligibleReceipts,
        settledReceiptCount: settlementSummary.settledReceiptCount,
        paidReceiptCount: settlementSummary.paidReceiptCount,
        recordedPayoutAmount: round2(settlementSummary.recordedPayoutAmount),
        paidPayoutAmount: round2(settlementSummary.paidPayoutAmount),
        basis: "OwnerSettlement receipt line items for OWNER-borne devices only",
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        financialSource: "Receipt records only",
        electricitySource: "ElectricityBill records for VJRA-borne projects",
        settlementSource: "OwnerSettlement receipt line items for OWNER-borne devices only",
        vjraFormula:
          "Gross Owner Payout = totals.taxableAmount - totals.vjraMarginAmount - sum(ElectricityBill.charges.energyCharges.amount); Net Owner Payout = Gross Owner Payout - sum(ElectricityBill.totalOwnerPayable)",
      },
    });
  } catch (error) {
    console.error("Admin owner monthly finance error:", error);
    return res.status(500).json({
      error: "Could not fetch monthly finance and settlement summary.",
    });
  }
});

module.exports = router;
