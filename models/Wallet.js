// Wallet Model for MongoDB
const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: 'XOF',
      enum: ['XOF', 'USD', 'EUR'],
    },
    totalIncome: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalExpense: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastTransactionDate: {
      type: Date,
      default: null,
    },
    frozenBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    metadata: {
      bankName: String,
      accountNumber: String,
      accountHolder: String,
    },
  },
  {
    timestamps: true,
    collection: 'wallets',
  }
);

// Index for faster queries
walletSchema.index({ createdAt: -1 });

const Wallet = mongoose.model('Wallet', walletSchema);

module.exports = Wallet;
