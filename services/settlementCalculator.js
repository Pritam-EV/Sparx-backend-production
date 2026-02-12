// services/settlementCalculator.js
module.exports = function calculateSettlement({
  units,
  userRatePerKwh,
  vjraMarginPerKwh,
  pgPercent,
  electricityBearer
}) {
  const GST_RATE = 0.18;

  const gross = units * userRatePerKwh;
  const gst = gross * GST_RATE;

  const vjraBase = units * vjraMarginPerKwh;
  const vjraGst = vjraBase * GST_RATE;

  const pgCharge = gross * (pgPercent / 100);

  const ownerPayout =
    electricityBearer === "OWNER"
      ? gross - gst - vjraBase - vjraGst - pgCharge
      : gross - gst - vjraBase - vjraGst - pgCharge; // electricity bill handled later

  return {
    gross,
    gst,
    pgCharge,
    vjra: {
      base: vjraBase,
      gst: vjraGst,
      total: vjraBase + vjraGst
    },
    ownerPayout
  };
};
