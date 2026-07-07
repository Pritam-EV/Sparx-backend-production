// models/ElectricityBill.js
// ─────────────────────────────────────────────────────────────────────────────
// Monthly Electricity Bill (EB) record for projects where
// commercial.electricityBearer === "VJRA".
//
// Lifecycle:
// uploaded → payment_submitted → payment_verified → eb_paid_to_mseb
//
// Charge responsibility:
// OWNER bears : todTariffEc, wheeling, demand, FAC, fixed, duty, tax on sale,
//               charges for excess demand, P.F. penal, debit adj,
//               rounding off, meter rent, power factor penalty,
//               delayed payment, regulatory, other
// VJRA bears  : energyCharges only
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require('mongoose');

// ─── Sub-schema: individual charge line ──────────────────────────────────────
const ChargeLineSchema = new mongoose.Schema(
  {
    amount: { type: Number, default: 0, min: 0 }, // ₹ value (0 if not applicable)
    remarks: { type: String, trim: true, default: '' } // optional admin note per line
  },
  { _id: false }
);

// ─── Sub-schema: owner payment record ────────────────────────────────────────
const OwnerPaymentSchema = new mongoose.Schema(
  {
    txnId: { type: String, trim: true },
    amountPaid: { type: Number, min: 0 },
    submittedAt: { type: Date },
    // Admin verification
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { _id: false }
);

// ─── Main schema ──────────────────────────────────────────────────────────────
const ElectricityBillSchema = new mongoose.Schema(
  {
    // ── IDENTIFICATION ─────────────────────────────────────────────────────
    // project: must match device.project field exactly (case-sensitive)
    project: {
      type: String,
      required: true,
      trim: true,
      index: true
    },

    // month: "YYYY-MM" format, e.g. "2026-05"
    month: {
      type: String,
      required: true,
      trim: true,
      match: [/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format'],
      index: true
    },

    // ── EB CHARGE BREAKDOWN (admin fills these from the MSEB bill) ─────────
    //
    // VJRA bears energyCharges; owner bears everything else.
    // All amounts in Indian Rupees (₹), stored as Number.

    charges: {
      // ── VJRA-bearing ──────────────────────────────────────────────────
      energyCharges: { ...ChargeLineSchema.obj }, // kWh-based consumption cost — VJRA pays

      // ── Owner-bearing (fixed / infra / tax / penalty charges) ────────
      todTariffEc: { ...ChargeLineSchema.obj }, // TOD Tariff EC (owner bearing)
      wheelingCharges: { ...ChargeLineSchema.obj }, // Transmission/distribution network use
      demandCharges: { ...ChargeLineSchema.obj }, // Maximum demand (kVA/kW) charges
      fac: { ...ChargeLineSchema.obj }, // Fuel Adjustment Charges
      fixedCharges: { ...ChargeLineSchema.obj }, // Fixed/customer charges
      electricityDuty: { ...ChargeLineSchema.obj }, // State electricity duty/tax
      taxOnSale: { ...ChargeLineSchema.obj }, // Tax on sale of electricity
      chargesForExcessDemand: { ...ChargeLineSchema.obj }, // Charges for excess demand
      pfPenalCharges: { ...ChargeLineSchema.obj }, // P.F. penal charges
      debitBillAdjustment: { ...ChargeLineSchema.obj }, // Debit bill adjustment
      roundingOffCharges: { ...ChargeLineSchema.obj }, // Rounding off charges
      meterRent: { ...ChargeLineSchema.obj }, // Meter rental charges
      powerFactorAdjustment: { ...ChargeLineSchema.obj }, // Penalty (+) or Incentive (−); can be negative
      delayedPaymentCharges: { ...ChargeLineSchema.obj }, // Late payment interest
      regulatoryCharges: { ...ChargeLineSchema.obj }, // MERC/regulatory surcharges
      otherCharges: { ...ChargeLineSchema.obj } // Catch-all for unlisted line items
    },

    extraCharges: [
      {
        label: { type: String, trim: true },
        amount: { type: Number, default: 0 }
      }
    ],

    // ── COMPUTED TOTALS (set by pre-save hook, do not set manually) ────────
    // Sum of all owner-bearing charge amounts
    totalOwnerPayable: { type: Number, default: 0, min: 0 },

    // Full EB total = energyCharges (VJRA) + totalOwnerPayable (owner)
    totalEBAmount: { type: Number, default: 0, min: 0 },

    // ── EB PDF (uploaded to Firebase Storage) ──────────────────────────────
    // Full gs:// or https:// path; signed URLs are generated on-demand
    ebPdfPath: {
      type: String,
      trim: true,
      default: null // null = PDF not yet uploaded
    },

    // ── STATUS MACHINE ─────────────────────────────────────────────────────
    //
    // uploaded          Admin saved EB data (PDF optional at this stage)
    // payment_submitted Owner recorded bank transfer (txnId + amount)
    // payment_verified  Admin confirmed money received from owner
    // eb_paid_to_mseb   VJRA has paid the EB to MSEB — final state
    //
    status: {
      type: String,
      enum: ['uploaded', 'payment_submitted', 'payment_verified', 'eb_paid_to_mseb'],
      default: 'uploaded',
      index: true
    },

    // ── OWNER PAYMENT RECORD ───────────────────────────────────────────────
    ownerPayment: OwnerPaymentSchema,

    // ── MSEB PAYMENT ───────────────────────────────────────────────────────
    msebPaidAt: { type: Date, default: null }, // When VJRA paid MSEB
    msebPaidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── AUDIT TRAIL ────────────────────────────────────────────────────────
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // ── SOFT-DELETE / VOID ─────────────────────────────────────────────────
    isVoided: { type: Boolean, default: false } // Admin can void an incorrect EB
  },
  {
    timestamps: true // adds createdAt, updatedAt automatically
  }
);

// ─── Compound unique index: one EB per project per month ─────────────────────
ElectricityBillSchema.index({ project: 1, month: 1 }, { unique: true });

// ─── Pre-save hook: auto-compute totals ──────────────────────────────────────
ElectricityBillSchema.pre('save', function (next) {
  const c = this.charges || {};

  // Helper: safely extract numeric amount from a charge line
  const amt = (line) => (line && typeof line.amount === 'number' ? line.amount : 0);

  // Owner-bearing lines (including TOD Tariff EC)
  const ownerLines = [
    amt(c.todTariffEc),
    amt(c.wheelingCharges),
    amt(c.demandCharges),
    amt(c.fac),
    amt(c.fixedCharges),
    amt(c.electricityDuty),
    amt(c.taxOnSale),
    amt(c.chargesForExcessDemand),
    amt(c.pfPenalCharges),
    amt(c.debitBillAdjustment),
    amt(c.roundingOffCharges),
    amt(c.meterRent),
    amt(c.powerFactorAdjustment), // can be negative (incentive)
    amt(c.delayedPaymentCharges),
    amt(c.regulatoryCharges),
    amt(c.otherCharges)
  ];

  this.totalOwnerPayable = Number(
    ownerLines.reduce((sum, v) => sum + v, 0).toFixed(2)
  );

  // Only energyCharges is VJRA-bearing
  this.totalEBAmount = Number(
    (this.totalOwnerPayable + amt(c.energyCharges)).toFixed(2)
  );

  next();
});

// ─── Instance method: check if PDF is available ───────────────────────────────
ElectricityBillSchema.methods.hasPdf = function () {
  return Boolean(this.ebPdfPath);
};

// ─── Instance method: human-readable status label ────────────────────────────
ElectricityBillSchema.methods.statusLabel = function () {
  const labels = {
    uploaded: 'EB Uploaded',
    payment_submitted: 'Payment Submitted by Owner',
    payment_verified: 'Payment Verified by VJRA',
    eb_paid_to_mseb: 'EB Paid to MSEB'
  };
  return labels[this.status] || this.status;
};

// ─── Static: fetch latest EB for a project (current/last month) ───────────────
ElectricityBillSchema.statics.latestForProject = function (project) {
  return this.findOne({ project, isVoided: false })
    .sort({ month: -1 })
    .exec();
};

// ─── Static: all pending payment verifications (for admin alert badge) ────────
ElectricityBillSchema.statics.pendingVerifications = function () {
  return this.find({ status: 'payment_submitted', isVoided: false })
    .sort({ updatedAt: -1 })
    .exec();
};

module.exports =
  mongoose.models.ElectricityBill ||
  mongoose.model('ElectricityBill', ElectricityBillSchema);