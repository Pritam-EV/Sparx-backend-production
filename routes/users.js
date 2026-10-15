const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const User = require("../models/User");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");

const SAFE_ADMIN_FIELDS = "_id name email mobile role";

const ALLOWED_ROLES = [
  "customer",
  "owner",
  "admin",
  "accountant",
];

function shapeAdminUser(user) {
  if (!user) return null;

  return {
    _id: String(user._id),
    name: user.name || "",
    email: user.email || "",
    mobile: user.mobile || "",
    role: user.role || "customer",
  };
}

// GET /api/users
// Admin-only: return only the fields needed by the admin user list.
router.get(
  "/",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const users = await User.find()
        .select(SAFE_ADMIN_FIELDS)
        .lean();

      return res.json(users.map(shapeAdminUser));
    } catch (err) {
      console.error("Fetch users error:", err.message);
      return res.status(500).json({
        error: "Failed to fetch users",
      });
    }
  }
);

// GET /api/users/:id
// Admin-only: fetch minimal user details for editing.
router.get(
  "/:id",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({
          error: "Invalid user ID",
        });
      }

      const user = await User.findById(req.params.id)
        .select(SAFE_ADMIN_FIELDS)
        .lean();

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.json(shapeAdminUser(user));
    } catch (err) {
      console.error("Fetch user error:", err.message);
      return res.status(500).json({
        error: "Failed to fetch user",
      });
    }
  }
);

// POST /api/users
// Admin-only: accept only the fields supported by the admin create form.
router.post(
  "/",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { name, email, mobile, role = "customer" } = req.body;

      if (
        typeof name !== "string" ||
        !name.trim() ||
        typeof email !== "string" ||
        !email.trim() ||
        typeof mobile !== "string" ||
        !mobile.trim()
      ) {
        return res.status(400).json({
          error: "Name, email and mobile are required",
        });
      }

      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({
          error: "Invalid role",
        });
      }

      const user = await User.create({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        mobile: mobile.trim(),
        role,
      });

      return res.status(201).json(
        shapeAdminUser(user)
      );
    } catch (err) {
      console.error("Create user error:", err.message);
      return res.status(400).json({
        error: "Failed to create user",
      });
    }
  }
);

// PUT /api/users/:id
// Admin-only: update only the fields used by the admin editor.
router.put(
  "/:id",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({
          error: "Invalid user ID",
        });
      }

      const update = {};
      const { name, email, mobile, role } = req.body;

      if (typeof name === "string") {
        if (!name.trim()) {
          return res.status(400).json({
            error: "Name cannot be empty",
          });
        }
        update.name = name.trim();
      }

      if (typeof email === "string") {
        update.email = email.trim().toLowerCase();
      }

      if (typeof mobile === "string") {
        update.mobile = mobile.trim();
      }

      if (typeof role !== "undefined") {
        if (!ALLOWED_ROLES.includes(role)) {
          return res.status(400).json({
            error: "Invalid role",
          });
        }
        update.role = role;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({
          error: "No valid fields provided for update",
        });
      }

      const user = await User.findByIdAndUpdate(
        req.params.id,
        update,
        { new: true, runValidators: true }
      )
        .select(SAFE_ADMIN_FIELDS)
        .lean();

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.json(shapeAdminUser(user));
    } catch (err) {
      console.error("Update user error:", err.message);
      return res.status(400).json({
        error: "Failed to update user",
      });
    }
  }
);

// DELETE /api/users/:id
// Admin-only.
router.delete(
  "/:id",
  authMiddleware,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({
          error: "Invalid user ID",
        });
      }

      const user = await User.findByIdAndDelete(req.params.id);

      if (!user) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.json({
        message: "User deleted successfully",
      });
    } catch (err) {
      console.error("Delete user error:", err.message);
      return res.status(500).json({
        error: "Failed to delete user",
      });
    }
  }
);

module.exports = router;