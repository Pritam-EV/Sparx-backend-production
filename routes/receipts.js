const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const Receipt = require('../models/Receipt');

router.get('/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const receipt = await Receipt.findOne({ sessionId, userId: req.user.userId });
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    res.json(receipt);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/receipts/:sessionId/rate
router.post("/:sessionId/rate", auth, async (req, res) => {
  const { sessionId } = req.params;
  const { rating } = req.body;
  if (rating < 1 || rating > 5) return res.status(400).json({ error: "Invalid rating" });
  await Receipt.updateOne(
    { sessionId, userId: req.user.userId },
    { rating }
  );
  res.json({ message: "Rating saved" });
});

// POST /api/receipts/:sessionId/suggest
router.post("/:sessionId/suggest", auth, async (req, res) => {
  const { sessionId } = req.params;
  const { suggestion } = req.body;
  if (!suggestion?.trim()) return res.status(400).json({ error: "Empty suggestion" });
  await Receipt.updateOne(
    { sessionId, userId: req.user.userId },
    { suggestion }
  );
  res.json({ message: "Suggestion saved" });
});


module.exports = router;
