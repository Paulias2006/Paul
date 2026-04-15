const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const Transaction = require('../models/Transaction');

// GET /api/payouts/my - list payouts for authenticated user (seller/courier)
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const userId = String(req.user.userId || '');
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'invalid_user' });
    }

    const txs = await Transaction.find({
      'metadata.payouts': { $exists: true }
    }).sort({ createdAt: -1 }).limit(200).lean();

    const payouts = [];
    for (const tx of txs) {
      const items = (tx.metadata && Array.isArray(tx.metadata.payouts)) ? tx.metadata.payouts : [];
      for (const p of items) {
        if (!p || !p.user_id) continue;
        if (String(p.user_id) !== userId) continue;
        payouts.push({
          orderId: tx.orderId || null,
          role: p.role || 'seller',
          amount: p.amount || 0,
          status: p.status || 'pending_external',
          reference: p.reference || null,
          provider: p.provider || null,
          leg_index: p.leg_index || null,
          createdAt: tx.createdAt || null
        });
      }
    }

    return res.json({ ok: true, payouts });
  } catch (error) {
    console.error('Get payouts error:', error);
    return res.status(500).json({ ok: false, error: 'fetch_failed', message: error.message });
  }
});

module.exports = router;
