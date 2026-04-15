/**
 * routes/wallet.js
 * Endpoints pour la gestion des wallets des utilisateurs
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const WalletService = require('../services/walletService');
const Wallet = require('../models/Wallet');

function normalizeUserId(value) {
  return String(value || '').trim();
}

router.get('/balance/:userId', async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_user_id',
        message: 'ID utilisateur invalide',
      });
    }

    const result = await WalletService.getBalance(userId);
    return res.json({
      ok: true,
      wallet: {
        userId,
        balance: result.balance,
        currency: result.currency,
        totalIncome: result.totalIncome,
        totalExpense: result.totalExpense,
        totalWithdrawn: result.totalWithdrawn,
      },
      balance: result.balance,
      currency: result.currency,
    });
  } catch (error) {
    console.error('Wallet public balance error:', error);
    return res.status(500).json({ ok: false, error: 'failed', message: error.message });
  }
});

router.post('/credit', async (req, res) => {
  try {
    const apiKey = String(req.headers['x-api-key'] || '').trim();
    const expected = String(process.env.WEEDELIVRED_API_KEY || '').trim();
    if (!expected || apiKey !== expected) {
      return res.status(401).json({ ok: false, error: 'invalid_api_key' });
    }

    const userId = normalizeUserId(req.body?.user_id);
    const amount = Number(req.body?.amount) || 0;
    const description = String(req.body?.description || 'Sync credit').trim();
    if (!userId || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }

    const result = await WalletService.credit(userId, amount, description, 'payment');
    return res.json({ ok: true, wallet: result.wallet, transaction: result.transaction });
  } catch (error) {
    console.error('Wallet credit route error:', error);
    return res.status(500).json({ ok: false, error: 'failed', message: error.message });
  }
});

router.use(authenticateToken);

router.get('/balance', async (req, res) => {
  try {
    const userId = normalizeUserId(req.user.userId);
    const result = await WalletService.getBalance(userId);
    return res.json({
      ok: true,
      wallet: {
        userId,
        balance: result.balance,
        currency: result.currency,
        totalIncome: result.totalIncome,
        totalExpense: result.totalExpense,
        totalWithdrawn: result.totalWithdrawn,
      },
      balance: result.balance,
      currency: result.currency,
      totalIncome: result.totalIncome,
      totalExpense: result.totalExpense,
      totalWithdrawn: result.totalWithdrawn,
    });
  } catch (error) {
    console.error('Wallet balance error:', error);
    return res.status(500).json({ ok: false, error: 'failed', message: error.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const userId = normalizeUserId(req.user.userId);
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    const skip = Number.parseInt(req.query.skip, 10) || 0;
    const result = await WalletService.getHistory(userId, limit, skip);
    return res.json({
      ok: true,
      transactions: result.transactions,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error('Wallet history route error:', error);
    return res.status(500).json({ ok: false, error: 'failed', message: error.message });
  }
});

router.post('/validate-balance', async (req, res) => {
  try {
    const userId = normalizeUserId(req.user.userId);
    const requiredAmount = Number(req.body?.requiredAmount) || 0;
    if (requiredAmount <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_amount',
        message: 'Montant invalide',
      });
    }

    const validation = await WalletService.validateBalance(userId, requiredAmount);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: 'insufficient_balance',
        message: validation.message,
        details: {
          required: validation.required,
          current: validation.current,
          shortage: validation.shortage,
        },
      });
    }

    return res.json({
      ok: true,
      message: 'Balance suffisante',
      balance: validation.balance,
    });
  } catch (error) {
    console.error('Wallet validate route error:', error);
    return res.status(500).json({ ok: false, error: 'failed', message: error.message });
  }
});

router.get('/details', async (req, res) => {
  try {
    const userId = normalizeUserId(req.user.userId);
    let wallet = await Wallet.findOne({ userId }).lean();
    if (!wallet) {
      await WalletService.getBalance(userId);
      wallet = await Wallet.findOne({ userId }).lean();
    }
    if (!wallet) {
      return res.status(404).json({
        ok: false,
        error: 'wallet_not_found',
        message: 'Wallet non trouve',
      });
    }

    return res.json({ ok: true, wallet });
  } catch (error) {
    console.error('Wallet details route error:', error);
    return res.status(500).json({ ok: false, error: 'failed', message: error.message });
  }
});

module.exports = router;
