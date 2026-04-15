/**
 * walletService.js - Service de gestion des wallets avec transactions
 */

const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const db = require('../db');

class WalletService {
  static _buildIdentifier(prefix = 'WL') {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  static async credit(userId, amount, description, type = 'payment') {
    try {
      if (!userId || amount <= 0) {
        throw new Error('Invalid userId or amount');
      }

      let wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        wallet = await db.createWallet(userId);
      }

      const balanceBefore = Number(wallet.balance || 0);
      const identifier = this._buildIdentifier('WL');

      wallet.balance = balanceBefore + amount;
      wallet.totalIncome = Number(wallet.totalIncome || 0) + amount;
      wallet.lastTransactionDate = new Date();
      await wallet.save();

      const transaction = new Transaction({
        wallet_id: wallet._id,
        userId: wallet.userId,
        type,
        amount,
        currency: wallet.currency || 'XOF',
        status: 'completed',
        identifier,
        reference_id: identifier,
        balance_before: balanceBefore,
        balance_after: Number(wallet.balance || 0),
        description: description || `Credit ${type}`,
        completedAt: new Date(),
        metadata: {
          source: 'wallet_service',
          direction: 'credit',
        },
      });
      await transaction.save();

      return {
        success: true,
        wallet: wallet.toObject(),
        transaction: transaction.toObject(),
      };
    } catch (error) {
      console.error('Wallet credit error:', error);
      throw error;
    }
  }

  static async debit(userId, amount, description, type = 'withdrawal') {
    try {
      if (!userId || amount <= 0) {
        throw new Error('Invalid userId or amount');
      }

      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      if (Number(wallet.balance || 0) < amount) {
        throw new Error(`Insufficient balance. Available: ${wallet.balance}, Requested: ${amount}`);
      }

      const balanceBefore = Number(wallet.balance || 0);
      const identifier = this._buildIdentifier(type === 'withdrawal' ? 'WD' : 'WL');

      wallet.balance = balanceBefore - amount;
      wallet.totalExpense = Number(wallet.totalExpense || 0) + amount;
      if (type === 'withdrawal') {
        wallet.totalWithdrawn = Number(wallet.totalWithdrawn || 0) + amount;
      }
      wallet.lastTransactionDate = new Date();
      await wallet.save();

      const transaction = new Transaction({
        wallet_id: wallet._id,
        userId: wallet.userId,
        type,
        amount,
        currency: wallet.currency || 'XOF',
        status: 'completed',
        identifier,
        reference_id: identifier,
        balance_before: balanceBefore,
        balance_after: Number(wallet.balance || 0),
        description: description || `Debit ${type}`,
        completedAt: new Date(),
        metadata: {
          source: 'wallet_service',
          direction: 'debit',
        },
      });
      await transaction.save();

      return {
        success: true,
        wallet: wallet.toObject(),
        transaction: transaction.toObject(),
      };
    } catch (error) {
      console.error('Wallet debit error:', error);
      throw error;
    }
  }

  static async transfer(fromUserId, toUserId, amount, description) {
    try {
      if (!fromUserId || !toUserId || amount <= 0) {
        throw new Error('Invalid parameters');
      }
      if (String(fromUserId) === String(toUserId)) {
        throw new Error('Cannot transfer to same wallet');
      }

      const fromWallet = await Wallet.findOne({ userId: fromUserId });
      if (!fromWallet || Number(fromWallet.balance || 0) < amount) {
        throw new Error('Insufficient balance');
      }

      const debitResult = await this.debit(
        fromUserId,
        amount,
        description || `Transfert vers ${toUserId}`,
        'transfer',
      );
      const creditResult = await this.credit(
        toUserId,
        amount,
        description || `Transfert de ${fromUserId}`,
        'transfer',
      );

      return {
        success: true,
        from: debitResult,
        to: creditResult,
      };
    } catch (error) {
      console.error('Wallet transfer error:', error);
      throw error;
    }
  }

  static async getHistory(userId, limit = 50, skip = 0) {
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      const transactions = await Transaction.find({ wallet_id: wallet._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const total = await Transaction.countDocuments({ wallet_id: wallet._id });

      return {
        success: true,
        transactions,
        pagination: {
          total,
          limit,
          skip,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      console.error('Wallet history error:', error);
      throw error;
    }
  }

  static async getBalance(userId) {
    try {
      let wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        wallet = await db.createWallet(userId);
      }

      return {
        success: true,
        balance: wallet.balance,
        currency: wallet.currency,
        totalIncome: wallet.totalIncome,
        totalExpense: wallet.totalExpense,
        totalWithdrawn: wallet.totalWithdrawn,
      };
    } catch (error) {
      console.error('Wallet balance error:', error);
      throw error;
    }
  }

  static async validateBalance(userId, requiredAmount) {
    try {
      const wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        return { valid: false, message: 'Wallet not found' };
      }

      if (Number(wallet.balance || 0) < requiredAmount) {
        return {
          valid: false,
          message: `Solde insuffisant. Disponible: ${wallet.balance}, Demande: ${requiredAmount}`,
          current: wallet.balance,
          required: requiredAmount,
          shortage: requiredAmount - wallet.balance,
        };
      }

      return { valid: true, balance: wallet.balance };
    } catch (error) {
      return { valid: false, message: error.message };
    }
  }
}

module.exports = WalletService;
