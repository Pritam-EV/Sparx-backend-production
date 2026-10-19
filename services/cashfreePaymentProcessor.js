// Shared Cashfree payment finalization for both webhook URLs and verification fallbacks.
"use strict";

const Payment = require("../models/Payment");
const { creditWallet } = require("./walletService");
const { fetchOrderDetails, fetchPaymentStatus } = require("./cashfreeVerify");

const TERMINAL_FAILURE_STATUSES = new Set(["EXPIRED", "CANCELLED", "TERMINATED"]);

function normalizeMethod(method) {
  if (method == null) return undefined;
  return typeof method === "string" ? method : JSON.stringify(method);
}

function paymentDate(paymentData) {
  const candidate = paymentData?.payment_time || paymentData?.payment_completion_time;
  if (!candidate) return new Date();
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function finalizeSuccessfulPayment(orderId, paymentData = {}, rawResponse, ip) {
  const payment = await Payment.findOne({ orderId });
  if (!payment) {
    console.warn(`[Cashfree] No local Payment record for order ${orderId}; ignoring.`);
    return { ignored: true, reason: "payment_record_not_found", orderId };
  }

  const paidAmount = Number(paymentData.payment_amount);
  if (Number.isFinite(paidAmount) && paidAmount > 0 &&
      Math.abs(paidAmount - Number(payment.amountPaid)) > 0.02) {
    throw new Error(
      `Cashfree amount mismatch for ${orderId}: expected ${payment.amountPaid}, received ${paidAmount}`
    );
  }

  // Always attempt the idempotent wallet credit, even if Payment is already SUCCESS.
  // This recovers the case where the payment status was saved but wallet credit previously failed.
  if (payment.type === "wallet_topup" && payment.gateway === "cashfree") {
    await creditWallet({
      userId: payment.userId.toString(),
      amount: Number(payment.amountPaid),
      type: "topup",
      orderId,
      description: "Wallet topup via Cashfree",
      idempotencyKey: `topup_${orderId}`,
      ip,
    });
  }

  const fields = {
    status: "SUCCESS",
    paidAt: paymentDate(paymentData),
    rawResponse: rawResponse || payment.rawResponse,
  };
  const method = normalizeMethod(paymentData.payment_method);
  if (method) fields.paymentMethod = method;
  if (paymentData.payment_group) fields.paymentGroup = paymentData.payment_group;
  if (paymentData.cf_payment_id != null) fields.cfPaymentId = String(paymentData.cf_payment_id);
  if (paymentData.bank_reference) fields.bankReference = String(paymentData.bank_reference);

  await Payment.updateOne({ orderId }, { $set: fields });
  return { success: true, orderId, type: payment.type, amountPaid: payment.amountPaid };
}

async function markFailedIfTerminal(orderId, event) {
  const orderResult = await fetchOrderDetails(orderId);
  if (!orderResult.success) {
    throw new Error(`Could not confirm terminal status for ${orderId}: ${orderResult.error}`);
  }

  const orderStatus = String(orderResult.order?.order_status || "").toUpperCase();
  if (!TERMINAL_FAILURE_STATUSES.has(orderStatus)) {
    // PAYMENT_FAILED / PAYMENT_USER_DROPPED describe an attempt, not necessarily the order.
    return { pending: true, orderId, orderStatus };
  }

  await Payment.updateOne(
    { orderId, status: { $ne: "SUCCESS" } },
    {
      $set: {
        status: "FAILED",
        failureReason:
          event?.data?.error_details?.error_description ||
          event?.data?.payment?.payment_message ||
          `Cashfree order reached terminal status ${orderStatus}`,
        rawResponse: event,
      },
    }
  );
  return { failed: true, orderId, orderStatus };
}

async function processCashfreePaymentEvent(event, options = {}) {
  const eventType = event?.type;
  const orderId = event?.data?.order?.order_id;
  if (!orderId) throw new Error("Cashfree payment event is missing data.order.order_id");

  if (eventType === "PAYMENT_SUCCESS") {
    return finalizeSuccessfulPayment(orderId, event?.data?.payment || {}, event, options.ip);
  }
  if (eventType === "PAYMENT_FAILED" || eventType === "PAYMENT_USER_DROPPED") {
    return markFailedIfTerminal(orderId, event);
  }
  return { ignored: true, reason: "unsupported_event", eventType };
}

async function reconcileCashfreeOrder(orderId, options = {}) {
  const result = await fetchOrderDetails(orderId);
  if (!result.success) return { success: false, error: result.error };

  const order = result.order || {};
  const orderStatus = String(order.order_status || "").toUpperCase();

  if (orderStatus === "PAID") {
    const paymentsResult = await fetchPaymentStatus(orderId);
    if (!paymentsResult.success) return { success: false, error: paymentsResult.error };

    const payments = Array.isArray(paymentsResult.payments)
      ? paymentsResult.payments
      : Array.isArray(paymentsResult.payments?.data)
        ? paymentsResult.payments.data
        : [];
    const latest = [...payments].reverse().find(p =>
      String(p?.payment_status || "").toUpperCase() === "SUCCESS"
    ) || {};
    const finalized = await finalizeSuccessfulPayment(
      orderId,
      {
        ...latest,
        payment_amount: latest.payment_amount ?? order.order_amount,
        payment_completion_time: latest.payment_completion_time,
      },
      { source: "cashfree_order_verification", order },
      options.ip
    );
    return { success: true, status: finalized.ignored ? "NOT_FOUND" : "SUCCESS", orderStatus, payment: finalized };
  }

  if (TERMINAL_FAILURE_STATUSES.has(orderStatus)) {
    await Payment.updateOne(
      { orderId, status: { $ne: "SUCCESS" } },
      {
        $set: {
          status: "FAILED",
          failureReason: `Cashfree order status: ${orderStatus}`,
          rawResponse: order,
        },
      }
    );
    return { success: true, status: "FAILED", orderStatus };
  }

  // Never convert an individual failed/dropped attempt to FAILED while the order remains active.
  return { success: true, status: "PENDING", orderStatus };
}

module.exports = { processCashfreePaymentEvent, reconcileCashfreeOrder };
