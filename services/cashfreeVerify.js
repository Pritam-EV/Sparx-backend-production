// services/cashfreeVerify.js
// Cashfree signature verification + live API helpers

const crypto = require("crypto");
const axios  = require("axios");

const CF_BASE = process.env.CASHFREE_ENV === "PROD"
  ? "https://api.cashfree.com/pg"
  : "https://sandbox.cashfree.com/pg";

const CF_HEADERS = {
  "x-api-version": "2023-08-01",
  "x-client-id":     process.env.CASHFREE_APP_ID,
  "x-client-secret": process.env.CASHFREE_SECRET_KEY,
  "Content-Type": "application/json",
};

// ── Webhook signature verification ──────────────────────────────────────────
// Cashfree signs: timestamp + rawBody
// Signature header: x-webhook-signature
// Timestamp header: x-webhook-timestamp
function verifyCashfreeWebhook(rawBody, signature, timestamp) {
  if (!rawBody || !signature || !timestamp) return false;
  const secret =
    process.env.CASHFREE_WEBHOOK_SECRET ||
    process.env.CASHFREE_SECRET_KEY ||
    "";
  if (!secret) return false;

  const computed = crypto
    .createHmac("sha256", secret)
    .update(String(timestamp) + (Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody)))
    .digest();
  const signatureValue = String(signature);
  // Reject malformed/non-canonical base64 before timing-safe comparison.
  if (!/^[A-Za-z0-9+\\/]+={0,2}$/.test(signatureValue)) return false;
  const received = Buffer.from(signatureValue, "base64");
  if (received.toString("base64") !== signatureValue) return false;

  // timingSafeEqual throws if buffer lengths differ.
  return received.length === computed.length && crypto.timingSafeEqual(received, computed);
}

// ── Fetch single order payment status from Cashfree ─────────────────────────
async function fetchPaymentStatus(orderId) {
  try {
    const { data } = await axios.get(`${CF_BASE}/orders/${orderId}/payments`, {
      headers: CF_HEADERS,
    });
    // Returns array of payments for the order
    return { success: true, payments: data };
  } catch (e) {
    return {
      success: false,
      error: e?.response?.data?.message || e.message,
    };
  }
}

// ── Fetch single order details ───────────────────────────────────────────────
async function fetchOrderDetails(orderId) {
  try {
    const { data } = await axios.get(`${CF_BASE}/orders/${orderId}`, {
      headers: CF_HEADERS,
    });
    return { success: true, order: data };
  } catch (e) {
    return {
      success: false,
      error: e?.response?.data?.message || e.message,
    };
  }
}

// ── Fetch settlements from Cashfree (for bank recon) ─────────────────────────
// from, to: "YYYY-MM-DD"
// ── Fetch settlements from Cashfree (for bank recon) ─────────────────────────
// Cashfree 2023-08-01: POST /pg/settlements/recon  (not GET /pg/settlements)
// from, to: "YYYY-MM-DD"
async function fetchSettlements(from, to) {
  try {
    const { data } = await axios.get(
      `${CF_BASE}/settlements`,
      {
        headers: CF_HEADERS,  // keeps 2023-08-01 — this endpoint supports it
        params: {
          start_date: from,  // YYYY-MM-DD
          end_date:   to,
          limit:      200,
        },
      }
    );

    // Response shape: { data: [...], cursor: "..." }
    return {
      success:     true,
      settlements: data?.data || [],
      cursor:      data?.cursor || null,
    };
  } catch (e) {
    return {
      success: false,
      error:   e?.response?.data?.message || e.message,
    };
  }
}

// ── Trigger refund via Cashfree API ─────────────────────────────────────────
async function initiateRefund({ orderId, refundId, amount, note }) {
  try {
    const { data } = await axios.post(
      `${CF_BASE}/orders/${orderId}/refunds`,
      {
        refund_amount: amount,
        refund_id:     refundId,
        refund_note:   note || "Customer refund",
      },
      { headers: CF_HEADERS }
    );
    return { success: true, refund: data };
  } catch (e) {
    return {
      success: false,
      error: e?.response?.data?.message || e.message,
    };
  }
}

module.exports = {
  verifyCashfreeWebhook,
  fetchPaymentStatus,
  fetchOrderDetails,
  fetchSettlements,
  initiateRefund,
};