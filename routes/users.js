// Users Routes
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Shop = require('../models/Shop');
const { authenticateToken } = require('../middleware/auth');

// Get user by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    const wallet = await Wallet.findOne({ userId: user._id });
    const shopCount = await Shop.countDocuments({ ownerId: user._id, deletedAt: null });

    return res.json({
      ok: true,
      user: user.toJSON(),
      wallet: wallet ? wallet.toObject() : null,
      stats: {
        shopCount,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Update current user profile (frontend calls /users/profile)
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const allowedUpdates = ['fullName', 'phone', 'avatar', 'metadata'];
    const update = {};

    allowedUpdates.forEach(field => {
      if (req.body[field]) {
        update[field] = req.body[field];
      }
    });

    const user = await User.findByIdAndUpdate(
      userId,
      update,
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    return res.json({
      ok: true,
      message: 'Profile updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: error.message,
    });
  }
});

// Update user profile (by ID)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    // Only allow users to update their own profile or admins
    if (req.user.userId.toString() !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only update your own profile',
      });
    }

    const allowedUpdates = ['fullName', 'avatar', 'metadata'];
    const update = {};

    allowedUpdates.forEach(field => {
      if (req.body[field]) {
        update[field] = req.body[field];
      }
    });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    return res.json({
      ok: true,
      message: 'Profile updated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: error.message,
    });
  }
});

// Get user transactions
router.get('/:id/transactions', authenticateToken, async (req, res) => {
  try {
    // Only allow users to see their own transactions or admins
    if (req.user.userId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only view your own transactions',
      });
    }

    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const type = req.query.type; // filter by type

    const query = { userId: req.params.id };
    if (type) {
      query.type = type;
    }

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .populate('shopId', 'name')
      .lean();

    const total = await Transaction.countDocuments(query);

    return res.json({
      ok: true,
      transactions,
      pagination: {
        total,
        limit,
        skip,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get user wallet
router.get('/:id/wallet', authenticateToken, async (req, res) => {
  try {
    // Only allow users to see their own wallet or admins
    if (req.user.userId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only view your own wallet',
      });
    }

    const wallet = await Wallet.findOne({ userId: req.params.id });
    if (!wallet) {
      return res.status(404).json({
        ok: false,
        error: 'wallet_not_found',
        message: 'Wallet not found',
      });
    }

    return res.json({
      ok: true,
      wallet: wallet.toObject(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get user shops (for sellers)
router.get('/:id/shops', authenticateToken, async (req, res) => {
  try {
    const shops = await Shop.find({
      ownerId: req.params.id,
      deletedAt: null,
    })
      .lean()
      .sort({ createdAt: -1 });

    return res.json({
      ok: true,
      shops,
      total: shops.length,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get all users (admin only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'Only admins can view all users',
      });
    }

    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const role = req.query.role; // filter by role

    const query = { deletedAt: null };
    if (role) {
      query.role = role;
    }

    const users = await User.find(query)
      .select('-passwordHash')
      .limit(limit)
      .skip(skip)
      .lean()
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(query);

    return res.json({
      ok: true,
      users,
      pagination: {
        total,
        limit,
        skip,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Update notification preferences
router.put('/:id/notification-preferences', authenticateToken, async (req, res) => {
  try {
    // Only allow users to update their own preferences
    console.log('DEBUG AUTH:', {
      userId: req.user.userId,
      userIdType: typeof req.user.userId,
      paramsId: req.params.id,
      paramsIdType: typeof req.params.id,
      equal: req.user.userId === req.params.id,
      equalString: req.user.userId.toString() === req.params.id.toString(),
      role: req.user.role
    });

    if (req.user.userId.toString() !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only update your own preferences',
      });
    }

    const { emailNotifications, smsNotifications, pushNotifications } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    user.metadata = user.metadata || {};
    user.metadata.notificationPreferences = {
      emailNotifications: emailNotifications !== undefined ? emailNotifications : user.metadata.notificationPreferences?.emailNotifications ?? true,
      smsNotifications: smsNotifications !== undefined ? smsNotifications : user.metadata.notificationPreferences?.smsNotifications ?? true,
      pushNotifications: pushNotifications !== undefined ? pushNotifications : user.metadata.notificationPreferences?.pushNotifications ?? true,
    };

    await user.save();

    return res.json({
      ok: true,
      message: 'Notification preferences updated',
      preferences: user.metadata.notificationPreferences,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Register FCM token for push notifications
router.post('/:id/fcm-token', authenticateToken, async (req, res) => {
  try {
    if (req.user.userId.toString() !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only update your own device tokens',
      });
    }

    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'invalid_token',
        message: 'FCM token is required',
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    user.metadata = user.metadata || {};
    user.metadata.fcmTokens = Array.isArray(user.metadata.fcmTokens) ? user.metadata.fcmTokens : [];
    if (!user.metadata.fcmTokens.includes(token)) {
      user.metadata.fcmTokens.push(token);
    }

    await user.save();

    return res.json({
      ok: true,
      message: 'FCM token registered',
      tokens: user.metadata.fcmTokens
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Deactivate account
router.post('/:id/deactivate', authenticateToken, async (req, res) => {
  try {
    // Only allow users to deactivate their own account
    if (req.user.userId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only deactivate your own account',
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    user.isActive = false;
    user.deletedAt = new Date();
    await user.save();

    return res.json({
      ok: true,
      message: 'Account deactivated successfully',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Reactivate account (soft-delete recovery)
router.post('/:id/reactivate', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Email and password are required',
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_password',
        message: 'Invalid password',
      });
    }

    user.isActive = true;
    user.deletedAt = null;
    await user.save();

    return res.json({
      ok: true,
      message: 'Account reactivated successfully',
      user: user.toJSON(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get user statistics/dashboard
router.get('/:id/stats', authenticateToken, async (req, res) => {
  try {
    // Only allow users to see their own stats
    if (req.user.userId !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'You can only view your own statistics',
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    const wallet = await Wallet.findOne({ userId: req.params.id });
    const transactionCount = await Transaction.countDocuments({ userId: req.params.id });
    const shopCount = await Shop.countDocuments({ ownerId: req.params.id, deletedAt: null });

    // Calculate total transactions amount
    const transactions = await Transaction.find({ userId: req.params.id }).select('amount');
    const totalTransactionAmount = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);

    return res.json({
      ok: true,
      stats: {
        user: {
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin,
        },
        wallet: wallet ? {
          balance: wallet.balance,
          totalIncome: wallet.totalIncome,
          totalExpense: wallet.totalExpense,
          totalWithdrawn: wallet.totalWithdrawn,
        } : null,
        transactions: {
          count: transactionCount,
          totalAmount: totalTransactionAmount,
        },
        shops: shopCount,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Get current user statistics (frontend calls /users/stats)
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    const wallet = await Wallet.findOne({ userId: userId });
    const transactionCount = await Transaction.countDocuments({ userId: userId });
    const shopCount = await Shop.countDocuments({ ownerId: userId, deletedAt: null });

    // Calculate total transactions amount
    const transactions = await Transaction.find({ userId: userId }).select('amount');
    const totalTransactionAmount = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);

    return res.json({
      ok: true,
      stats: {
        totalTransactions: transactionCount,
        totalAmount: totalTransactionAmount,
        lastLogin: user.lastLogin,
        accountCreated: user.createdAt,
        status: user.isActive ? 'active' : 'inactive',
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

// Deactivate current user account (frontend calls /users/deactivate)
router.post('/deactivate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        ok: false,
        error: 'password_required',
        message: 'Mot de passe requis pour désactiver le compte'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'Utilisateur non trouvé'
      });
    }

    // Vérifier le mot de passe
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_password',
        message: 'Mot de passe incorrect'
      });
    }

    // Désactiver le compte
    user.isActive = false;
    user.deletedAt = new Date();
    await user.save();

    return res.json({
      ok: true,
      message: 'Compte désactivé avec succès'
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: error.message,
    });
  }
});

module.exports = router;
