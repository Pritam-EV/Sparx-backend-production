const mongoose = require("mongoose");
const User = require("../models/User");
const WalletTransaction = require("../models/WalletTransaction");
const crypto = require("crypto");

// RBI limits
const MIN_KYC_MAX_BALANCE = 10000;
const MIN_KYC_MONTHLY_LOAD_LIMIT = 10000;
const FULL_KYC_MAX_BALANCE = 200000;

/**
 * Credit wallet — used for topup, refunds, admin credits
 * All operations are atomic via MongoDB session (transaction)
 */
async function creditWallet({ userId, amount, type, orderId, sessionId, description, idempotencyKey, ip }) {
  if (!["topup", "refund", "admin_credit"].includes(type))
    throw new Error("Invalid credit type");

  // Idempotency check — if this key was already processed, return existing record
  if (idempotencyKey) {
    const existing = await WalletTransaction.findOne({ idempotencyKey });
    if (existing) return { alreadyProcessed: true, transaction: existing };
  }

  const dbSession = await mongoose.startSession();
  dbSession.startTransaction();
  try {
    const user = await User.findById(userId).session(dbSession);
    if (!user) throw new Error("User not found");
    if (user.walletFrozen) throw new Error("Wallet is frozen");

    // RBI: monthly load limit check (only for topup)
    if (type === "topup") {
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (user.walletLastResetMonth !== currentMonth) {
        user.walletMonthlyLoaded = 0;
        user.walletLastResetMonth = currentMonth;
      }
      const newMonthlyTotal = (user.walletMonthlyLoaded || 0) + amount;
      const monthlyLimit = user.walletKycLevel === "full_kyc"
        ? Infinity
        : MIN_KYC_MONTHLY_LOAD_LIMIT;
      if (newMonthlyTotal > monthlyLimit)
        throw new Error(`Monthly wallet load limit (₹${monthlyLimit}) exceeded`);

      // RBI: balance cap
      const balanceCap = user.walletKycLevel === "full_kyc"
        ? FULL_KYC_MAX_BALANCE
        : MIN_KYC_MAX_BALANCE;
      if (user.walletBalance + amount > balanceCap)
        throw new Error(`Wallet balance cannot exceed ₹${balanceCap}`);

      user.walletMonthlyLoaded = newMonthlyTotal;
    }

    const balanceBefore = user.walletBalance;
    user.walletBalance = Number((user.walletBalance + amount).toFixed(2));

    await user.save({ session: dbSession });

    const txn = await WalletTransaction.create([{
      userId,
      type,
      amount,
      balanceBefore,
      balanceAfter: user.walletBalance,
      orderId: orderId || null,
      sessionId: sessionId || null,
      description: description || null,
      idempotencyKey: idempotencyKey || null,
      initiatedBy: type === "admin_credit" ? "admin" : (type === "topup" ? "user" : "system"),
      ip: ip || null,
    }], { session: dbSession });

    await dbSession.commitTransaction();
    return { success: true, newBalance: user.walletBalance, transaction: txn[0] };
  } catch (err) {
    await dbSession.abortTransaction();
    throw err;
  } finally {
    dbSession.endSession();
  }
}

/**
 * Debit wallet — used for charging session payment
 * Atomic check-and-debit: re-reads balance inside transaction
 */
async function debitWallet({ userId, amount, sessionId, orderId, description, idempotencyKey, ip }) {
  // Idempotency check
  if (idempotencyKey) {
    const existing = await WalletTransaction.findOne({ idempotencyKey });
    if (existing) return { alreadyProcessed: true, transaction: existing };
  }

  const dbSession = await mongoose.startSession();
  dbSession.startTransaction();
  try {
    const user = await User.findById(userId).session(dbSession);
    if (!user) throw new Error("User not found");
    if (user.walletFrozen) throw new Error("Wallet is frozen");
    if (user.walletBalance < amount)
      throw new Error("Insufficient wallet balance");

    const balanceBefore = user.walletBalance;
    user.walletBalance = Number((user.walletBalance - amount).toFixed(2));

    await user.save({ session: dbSession });

    const txn = await WalletTransaction.create([{
      userId,
      type: "debit",
      amount,
      balanceBefore,
      balanceAfter: user.walletBalance,
      orderId: orderId || null,
      sessionId: sessionId || null,
      description: description || "Charging session payment",
      idempotencyKey: idempotencyKey || null,
      initiatedBy: "system",
      ip: ip || null,
    }], { session: dbSession });

    await dbSession.commitTransaction();
    return { success: true, newBalance: user.walletBalance, transaction: txn[0] };
  } catch (err) {
    await dbSession.abortTransaction();
    throw err;
  } finally {
    dbSession.endSession();
  }
}

module.exports = { creditWallet, debitWallet };