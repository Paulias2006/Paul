// Authentication Routes - Weedelivred Backend
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const db = require('../db');
const { registerValidators, loginValidators, validate } = require('../middleware/validation');
const { authenticateToken } = require('../middleware/auth');
const { sendOTPEmail, sendPasswordResetEmail } = require('../services/emailService');

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-here';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-key-here';
const JWT_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY = '7d';

// Helper function to generate tokens
const generateTokens = (user) => {
  const accessToken = jwt.sign(
    {
      userId: user._id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  const refreshToken = jwt.sign(
    {
      userId: user._id,
    },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );

  return { accessToken, refreshToken };
};

const PAYOUT_NETWORKS = new Set(['FLOOZ', 'TMONEY']);

function normalizeTogoPhone(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim().replace(/\s+/g, '');
  if (!raw) return null;

  if (/^\+228\d{8}$/.test(raw)) return raw;
  if (/^228\d{8}$/.test(raw)) return `+${raw}`;
  if (/^\d{8}$/.test(raw)) return `+228${raw}`;

  return null;
}

// ==================== REGISTER ====================
router.post('/register', registerValidators, validate, async (req, res) => {
  try {
    const { email, phone, fullName, password } = req.body;

    // Check if user already exists
    let existingUser = await User.findOne({ $or: [{ email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({
        ok: false,
        error: 'user_exists',
        message: 'User with this email or phone already exists',
      });
    }

    // Create new user
    const user = new User({
      email,
      phone,
      fullName,
      passwordHash: password, // Will be hashed by pre-save middleware
      role: 'buyer',
    });

    await user.save();

    // Generate and send OTP verification
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.metadata = user.metadata || {};
    user.metadata.otpCode = otp;
    user.metadata.otpExpires = new Date(Date.now() + 600000); // 10 minutes
    await user.save();

    // Send OTP email
    const emailSent = await sendOTPEmail(user.email, user.fullName, otp);

    // Create wallet automatically
    await db.createWallet(user._id);

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    return res.status(201).json({
      ok: true,
      message: 'User registered successfully. Please verify your email with the OTP code.',
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        createdAt: user.createdAt,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
      emailSent,
    });

  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({
      ok: false,
      error: 'registration_failed',
      message: 'Failed to register user',
    });
  }
});

// ==================== VERIFY OTP ====================
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Email and OTP are required',
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

    if (user.isEmailVerified) {
      return res.status(400).json({
        ok: false,
        error: 'already_verified',
        message: 'Email already verified',
      });
    }

    if (!user.metadata?.otpCode || !user.metadata?.otpExpires) {
      return res.status(400).json({
        ok: false,
        error: 'no_otp',
        message: 'No OTP found. Please request a new one.',
      });
    }

    console.log('DEBUG OTP:', {
      stored: user.metadata.otpCode,
      storedType: typeof user.metadata.otpCode,
      input: otp,
      inputType: typeof otp,
      equal: user.metadata.otpCode === otp
    });

    if (user.metadata.otpCode !== otp) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_otp',
        message: 'Invalid OTP code',
      });
    }

    if (new Date() > user.metadata.otpExpires) {
      return res.status(400).json({
        ok: false,
        error: 'expired_otp',
        message: 'OTP code has expired',
      });
    }

    // Verify email
    user.isEmailVerified = true;
    user.metadata.otpCode = null;
    user.metadata.otpExpires = null;
    await user.save();

    return res.json({
      ok: true,
      message: 'Email verified successfully',
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        isEmailVerified: user.isEmailVerified,
      },
    });

  } catch (error) {
    console.error('OTP verification error:', error);
    return res.status(500).json({
      ok: false,
      error: 'verification_failed',
      message: 'Failed to verify OTP',
    });
  }
});

// ==================== RESEND OTP ====================
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'missing_email',
        message: 'Email is required',
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

    if (user.isEmailVerified) {
      return res.status(400).json({
        ok: false,
        error: 'already_verified',
        message: 'Email already verified',
      });
    }

    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.metadata = user.metadata || {};
    user.metadata.otpCode = otp;
    user.metadata.otpExpires = new Date(Date.now() + 600000); // 10 minutes
    await user.save();

    // Send OTP email
    const emailSent = await sendOTPEmail(user.email, user.fullName, otp);

    return res.json({
      ok: true,
      message: 'OTP sent successfully',
      emailSent,
    });

  } catch (error) {
    console.error('Resend OTP error:', error);
    return res.status(500).json({
      ok: false,
      error: 'resend_failed',
      message: 'Failed to resend OTP',
    });
  }
});

// ==================== LOGIN ====================
router.post('/login', loginValidators, validate, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_credentials',
        message: 'Invalid email or password',
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_credentials',
        message: 'Invalid email or password',
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({
        ok: false,
        error: 'account_disabled',
        message: 'Account is disabled',
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Get wallet info
    const wallet = await Wallet.findOne({ userId: user._id });

    return res.json({
      ok: true,
      message: 'Login successful',
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        lastLogin: user.lastLogin,
        avatar: user.avatar,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
      wallet: wallet ? {
        balance: wallet.balance,
        currency: wallet.currency,
        totalIncome: wallet.totalIncome,
        totalExpense: wallet.totalExpense,
      } : null,
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      ok: false,
      error: 'login_failed',
      message: 'Login failed',
    });
  }
});

// ==================== REFRESH TOKEN ====================
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        ok: false,
        error: 'missing_token',
        message: 'Refresh token is required',
      });
    }

    // Verify refresh token
    jwt.verify(refreshToken, JWT_REFRESH_SECRET, async (err, decoded) => {
      if (err) {
        return res.status(403).json({
          ok: false,
          error: 'invalid_refresh_token',
          message: 'Invalid refresh token',
        });
      }

      // Find user
      const user = await User.findById(decoded.userId);
      if (!user) {
        return res.status(404).json({
          ok: false,
          error: 'user_not_found',
          message: 'User not found',
        });
      }

      // Generate new tokens
      const tokens = generateTokens(user);

      return res.json({
        ok: true,
        message: 'Token refreshed successfully',
        tokens,
      });
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    return res.status(500).json({
      ok: false,
      error: 'refresh_failed',
      message: 'Failed to refresh token',
    });
  }
});

// ==================== FORGOT PASSWORD ====================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'missing_email',
        message: 'Email is required',
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists or not for security
      return res.json({
        ok: true,
        message: 'If the email exists, a password reset link has been sent.',
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 3600000); // 1 hour
    await user.save();

    // Create reset link
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

    // Send reset email
    const emailSent = await sendPasswordResetEmail(user.email, user.fullName, resetToken, resetLink);

    return res.json({
      ok: true,
      message: 'If the email exists, a password reset link has been sent.',
      emailSent,
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({
      ok: false,
      error: 'reset_failed',
      message: 'Failed to process password reset request',
    });
  }
});

// ==================== RESET PASSWORD ====================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Token, new password, and confirmation are required',
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        error: 'passwords_not_match',
        message: 'Passwords do not match',
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        error: 'weak_password',
        message: 'Password must be at least 8 characters',
      });
    }

    // Find user with valid reset token
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_token',
        message: 'Token de réinitialisation invalide ou expiré',
      });
    }

    // Update password
    user.passwordHash = newPassword;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    user.lastPasswordChange = new Date();
    await user.save();

    return res.json({
      ok: true,
      message: 'Mot de passe réinitialisé avec succès. Connectez-vous avec votre nouveau mot de passe.',
    });

  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({
      ok: false,
      error: 'reset_failed',
      message: 'Failed to reset password',
    });
  }
});

// ==================== GET CURRENT USER ====================
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    // Get wallet info
    const wallet = await Wallet.findOne({ userId: user._id });

    return res.json({
      ok: true,
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        lastLogin: user.lastLogin,
        avatar: user.avatar,
        createdAt: user.createdAt,
        metadata: user.metadata,
      },
      wallet: wallet ? {
        balance: wallet.balance,
        currency: wallet.currency,
        totalIncome: wallet.totalIncome,
        totalExpense: wallet.totalExpense,
        lastTransactionDate: wallet.lastTransactionDate,
      } : null,
    });

  } catch (error) {
    console.error('Get current user error:', error);
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      message: 'Failed to fetch user data',
    });
  }
});

// ==================== PAYOUT SETTINGS ====================
router.get('/payout-settings', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    const metadata = user.metadata || {};
    return res.json({
      ok: true,
      payoutSettings: {
        phone: metadata.payoutPhone ?? null,
        network: metadata.payoutNetwork ?? null,
        accountName: metadata.payoutAccountName ?? null,
        autoPayoutEnabled: metadata.autoPayoutEnabled !== false,
        updatedAt: metadata.payoutUpdatedAt ?? null,
      },
    });
  } catch (error) {
    console.error('Get payout settings error:', error);
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: 'Failed to fetch payout settings',
    });
  }
});

router.put('/payout-settings', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    const metadata = user.metadata || {};
    const hasPhone = Object.prototype.hasOwnProperty.call(req.body, 'phone');
    const hasNetwork = Object.prototype.hasOwnProperty.call(req.body, 'network');
    const hasAccountName = Object.prototype.hasOwnProperty.call(req.body, 'accountName');
    const hasAutoPayout = Object.prototype.hasOwnProperty.call(req.body, 'autoPayoutEnabled');

    if (hasPhone) {
      const normalized = normalizeTogoPhone(req.body.phone);
      if (req.body.phone && !normalized) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_phone',
          message: 'Le numero payout doit etre au format +228XXXXXXXX',
        });
      }
      metadata.payoutPhone = normalized;
    }

    if (hasNetwork) {
      const network = String(req.body.network || '').trim().toUpperCase();
      if (network && !PAYOUT_NETWORKS.has(network)) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_network',
          message: 'Reseau payout invalide (FLOOZ ou TMONEY)',
        });
      }
      metadata.payoutNetwork = network || null;
    }

    if (hasAccountName) {
      const accountName = String(req.body.accountName || '').trim();
      metadata.payoutAccountName = accountName || null;
    }

    if (hasAutoPayout) {
      metadata.autoPayoutEnabled = Boolean(req.body.autoPayoutEnabled);
    }

    metadata.payoutUpdatedAt = new Date();
    user.metadata = metadata;
    await user.save();

    return res.json({
      ok: true,
      message: 'Parametres payout enregistres',
      payoutSettings: {
        phone: metadata.payoutPhone ?? null,
        network: metadata.payoutNetwork ?? null,
        accountName: metadata.payoutAccountName ?? null,
        autoPayoutEnabled: metadata.autoPayoutEnabled !== false,
        updatedAt: metadata.payoutUpdatedAt,
      },
    });
  } catch (error) {
    console.error('Update payout settings error:', error);
    return res.status(500).json({
      ok: false,
      error: 'failed',
      message: 'Failed to update payout settings',
    });
  }
});

// ==================== CHANGE PASSWORD ====================
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Tous les champs sont requis',
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        ok: false,
        error: 'passwords_not_match',
        message: 'Les mots de passe ne correspondent pas',
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        error: 'weak_password',
        message: 'Le mot de passe doit avoir au moins 8 caractères',
      });
    }

    // Get user
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'Utilisateur non trouvé',
      });
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_password',
        message: 'Le mot de passe actuel est incorrect',
      });
    }

    // Update password
    user.passwordHash = newPassword;
    user.lastPasswordChange = new Date();
    await user.save();

    return res.json({
      ok: true,
      message: 'Mot de passe changé avec succès',
    });

  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({
      ok: false,
      error: 'change_failed',
      message: 'Failed to change password',
    });
  }
});

// ==================== LOGOUT ====================
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // In a stateless JWT system, logout is handled client-side
    // by removing the token. Optionally, you could implement
    // a token blacklist here for enhanced security.

    return res.json({
      ok: true,
      message: 'Logout successful',
    });

  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({
      ok: false,
      error: 'logout_failed',
      message: 'Failed to logout',
    });
  }
});

// ==================== SEND ADMIN NOTIFICATION ====================
router.post('/send-admin-notification', async (req, res) => {
  try {
    const { subject, content } = req.body;

    if (!subject || !content) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Subject and content are required',
      });
    }

    const { sendAdminNotification } = require('../services/emailService');
    const emailSent = await sendAdminNotification(subject, content);

    if (emailSent) {
      return res.json({
        ok: true,
        message: 'Admin notification sent successfully',
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: 'send_failed',
        message: 'Failed to send admin notification',
      });
    }

  } catch (error) {
    console.error('Send admin notification error:', error);
    return res.status(500).json({
      ok: false,
      error: 'send_failed',
      message: 'Failed to send admin notification',
    });
  }
});

// ==================== UPDATE PROFILE ====================
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, phone, avatar } = req.body;

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: 'user_not_found',
        message: 'User not found',
      });
    }

    // Update allowed fields
    if (fullName) user.fullName = fullName;
    if (phone) user.phone = phone;
    if (avatar !== undefined) user.avatar = avatar;

    await user.save();

    return res.json({
      ok: true,
      message: 'Profile updated successfully',
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        avatar: user.avatar,
      },
    });

  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: 'Failed to update profile',
    });
  }
});

module.exports = router;
