// utils/ownerScope.js

const mongoose = require("mongoose");
const Device = require("../models/device");

/**
 * Check whether a value is a valid MongoDB ObjectId.
 */
function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

/**
 * Get the device IDs assigned to an owner.
 *
 * Device.ownerId is an array of ObjectIds in the current schema.
 * MongoDB's equality query matches an element in that array.
 */
async function getOwnedDeviceIds(ownerId) {
  if (!isValidObjectId(ownerId)) {
    return [];
  }

  const ownerObjectId = new mongoose.Types.ObjectId(ownerId);

  const devices = await Device.find({
    ownerId: ownerObjectId,
  })
    .select("device_id -_id")
    .lean();

  return devices
    .map((device) => device.device_id)
    .filter(Boolean);
}

/**
 * Escape user-supplied text before using it in a regular expression.
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  isValidObjectId,
  getOwnedDeviceIds,
  escapeRegex,
};