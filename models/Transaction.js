// Transaction Model for MongoDB
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    wallet_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Wallet',
      default: null,
      index: true,
    },
    orderId: {
      // Keep as string to support Mongo ObjectId order IDs from Weeshop
      // and legacy numeric IDs from older flows.
      type: String,
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shop',
      default: null,
    },
    type: {
      type: String,
      enum: ['payment', 'withdrawal', 'transfer', 'refund', 'commission'],
      default: 'payment',
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    balance_before: {
      type: Number,
      default: 0,
    },
    balance_after: {
      type: Number,
      default: 0,
    },
    currency: {
      type: String,
      default: 'XOF',
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded'],
      default: 'pending',
    },
    identifier: {
      type: String,
      unique: true,
      required: true,
      // Format: ATG-1234567890-1234 or WD-1234567890-1234
    },
    paygateTxReference: {
      type: String,
      unique: true,
      sparse: true,
    },
    paymentReference: {
      type: String,
      default: null,
      // Reference code from Flooz/TMoney for support
    },
    paymentMethod: {
      type: String,
      enum: ['FLOOZ', 'TMONEY', 'mtn', 'moov', 'bank_transfer', 'wallet', 'manual'],
      default: null,
    },
    phoneNumber: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      default: '',
    },
    reference_id: {
      type: String,
      default: null,
    },
    method: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    qrToken: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    // Keep metadata fully flexible because QR/payment payloads carry
    // dynamic fields (orderId raw, product/transport split, seller payout data, etc.).
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    errorDetails: {
      code: String,
      message: String,
      timestamp: Date,
    },
  },
  {
    timestamps: true,
    collection: 'transactions',
  }
);

// Index for faster queries
transactionSchema.index({ userId: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ type: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
