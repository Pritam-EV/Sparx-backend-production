// utils/sanitizeUser.js
// Only return fields required by the customer-facing application.

function sanitizeUser(user) {
  if (!user) return null;

  const source =
    typeof user.toObject === "function"
      ? user.toObject()
      : user;

  return {
    _id: source._id ? String(source._id) : null,
    name: source.name ?? "",
    email: source.email ?? "",
    mobile: source.mobile ?? "",
    vehicleType: source.vehicleType ?? "",
    vehicleModel: source.vehicleModel ?? "",
    vehicleNumber: source.vehicleNumber ?? "",
    gstin: source.gstin ?? "",
    role: source.role || "customer",
    phoneVerified: Boolean(source.phoneVerified),
  };
}

module.exports = sanitizeUser;