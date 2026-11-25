const mongoose = require("mongoose");

const ProductionProfile = require("../../models/ProductionProfile");
const FirmwareProfile = require("../../models/FirmwareProfile");
const CalibrationProfile = require("../../models/CalibrationProfile");

const PROFILE_MODELS = {
  production: ProductionProfile,
  firmware: FirmwareProfile,
  calibration: CalibrationProfile,
};

function getModel(type) {
  return PROFILE_MODELS[String(type || "").toLowerCase()] || null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allowedFields(Model) {
  return Object.keys(Model.schema.obj).filter(
    (field) => ![
      "_id",
      "__v",
      "createdAt",
      "updatedAt",
      "createdBy",
      "updatedBy",
    ].includes(field)
  );
}

function validateBody(body) {
  return (
    body &&
    typeof body === "object" &&
    !Array.isArray(body)
  );
}


// ==================================================
// GET /profiles/:profileType
// ==================================================

exports.getProfiles = async (req, res) => {
  try {
    const Model = getModel(req.params.profileType);

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "profileType must be production, firmware or calibration.",
      });
    }

    const page = Math.max(
      1,
      Number.parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(req.query.limit, 10) || 25
      )
    );

    const filter = {};

    if (req.query.status) {
      if (req.params.profileType === "production") {
        filter.isActive = req.query.status === "active";
      } else {
        filter.status = String(req.query.status);
      }
    }

    if (req.query.search) {
      const regex = new RegExp(
        escapeRegex(String(req.query.search).trim()),
        "i"
      );

      filter.$or = [
        { profileName: regex },
        { profileCode: regex },
      ];
    }

    const [profiles, total] = await Promise.all([
      Model.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      Model.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: profiles,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Production V3] getProfiles:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch profiles.",
    });
  }
};


// ==================================================
// GET /profiles/:profileType/:profileId
// ==================================================

exports.getProfileById = async (req, res) => {
  try {
    const Model = getModel(req.params.profileType);

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile type.",
      });
    }

    const { profileId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile ID.",
      });
    }

    const profile = await Model.findById(profileId).lean();

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profile not found.",
      });
    }

    return res.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    console.error("[Production V3] getProfileById:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch profile.",
    });
  }
};


// ==================================================
// POST /profiles/:profileType
// ==================================================

exports.createProfile = async (req, res) => {
  try {
    const Model = getModel(req.params.profileType);

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile type.",
      });
    }

    if (!validateBody(req.body)) {
      return res.status(400).json({
        success: false,
        message: "Request body must be a JSON object.",
      });
    }

    const fields = allowedFields(Model);

    const unsupported = Object.keys(req.body).filter(
      (field) => !fields.includes(field)
    );

    if (unsupported.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Unsupported profile fields.",
        unsupportedFields: unsupported,
      });
    }

    const profile = new Model({
      ...req.body,
      createdBy: req.user?.userId || null,
      updatedBy: req.user?.userId || null,
    });

    await profile.save();

    return res.status(201).json({
      success: true,
      message: "Profile created successfully.",
      data: profile,
    });
  } catch (error) {
    console.error("[Production V3] createProfile:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Profile code/version already exists.",
      });
    }

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Profile validation failed.",
        errors: Object.values(error.errors).map(
          (item) => item.message
        ),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create profile.",
    });
  }
};


// ==================================================
// PATCH /profiles/:profileType/:profileId
// ==================================================

exports.updateProfile = async (req, res) => {
  try {
    const Model = getModel(req.params.profileType);

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile type.",
      });
    }

    const { profileId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid profile ID.",
      });
    }

    if (!validateBody(req.body) || !Object.keys(req.body).length) {
      return res.status(400).json({
        success: false,
        message: "A non-empty JSON object is required.",
      });
    }

    const immutableFields = [
      "profileCode",
      "profileVersion",
      "_id",
      "__v",
      "createdAt",
      "updatedAt",
      "createdBy",
    ];

    const fields = allowedFields(Model);

    const unsupported = Object.keys(req.body).filter(
      (field) =>
        immutableFields.includes(field) ||
        !fields.includes(field)
    );

    if (unsupported.length > 0) {
      return res.status(400).json({
        success: false,
        message: "One or more profile fields are immutable or unsupported.",
        unsupportedFields: unsupported,
      });
    }

    const profile = await Model.findById(profileId);

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profile not found.",
      });
    }

    for (const [field, value] of Object.entries(req.body)) {
      profile.set(field, value);
    }

    profile.updatedBy = req.user?.userId || null;

    await profile.save();

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      data: profile,
    });
  } catch (error) {
    console.error("[Production V3] updateProfile:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Profile code/version already exists.",
      });
    }

    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Profile validation failed.",
        errors: Object.values(error.errors).map(
          (item) => item.message
        ),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update profile.",
    });
  }
};