const express = require('express');
const User = require('../models/User');

const router = express.Router();

function requireAdminKey(req, res) {
  const configuredKey = String(process.env.ADMIN_CREATE_USER_KEY || '').trim();
  const providedKey = String(req.headers['x-admin-key'] || '').trim();
  if (!configuredKey || providedKey !== configuredKey) {
    res.status(403).json({
      ok: false,
      error: 'admin_only',
      message: 'Acces admin refuse',
    });
    return false;
  }
  return true;
}

router.get('/users', async (req, res) => {
  try {
    if (!requireAdminKey(req, res)) return;
    const q = String(req.query.q || '').trim();
    const query = { deletedAt: null };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ email: rx }, { phone: rx }, { fullName: rx }];
    }
    const users = await User.find(query).sort({ createdAt: -1 }).limit(800).lean();
    res.json({
      summary: { count: users.length },
      items: users.map((user) => ({
        id: String(user._id),
        fullName: user.fullName || '',
        email: user.email || '',
        phone: user.phone || '',
        role: user.role || 'buyer',
        isActive: user.isActive !== false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastPasswordChange: user.lastPasswordChange || null,
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Failed to list users' });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    if (!requireAdminKey(req, res)) return;
    const { id } = req.params;
    const newPassword = String(req.body.newPassword || '').trim();
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ ok: false, message: 'Mot de passe invalide (min 8)' });
    }
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ ok: false, message: 'User not found' });
    }
    user.passwordHash = newPassword;
    user.lastPasswordChange = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Failed to reset password' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (!requireAdminKey(req, res)) return;
    await User.updateOne({ _id: req.params.id }, { $set: { isActive: false, deletedAt: new Date() } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || 'Failed to delete user' });
  }
});

module.exports = router;
