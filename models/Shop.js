// Shop Model for MongoDB
const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      required: true,
      enum: ['electronics', 'clothing', 'food', 'services', 'other'],
    },
    logo: {
      type: String,
      default: null,
    },
    coverImage: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      default: null,
    },
    address: {
      type: String,
      default: '',
    },
    city: {
      type: String,
      default: '',
    },
    country: {
      type: String,
      default: 'Burkina Faso',
    },
    website: {
      type: String,
      default: null,
    },
    rating: {
      type: Number,
      default: 5.0,
      min: 0,
      max: 5,
    },
    reviewCount: {
      type: Number,
      default: 0,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    productCount: {
      type: Number,
      default: 0,
    },
    totalSales: {
      type: Number,
      default: 0,
    },
    totalRevenue: {
      type: Number,
      default: 0,
    },
    commissionRate: {
      type: Number,
      default: 5, // percentage
      min: 0,
      max: 100,
    },
    metadata: {
      socialMedia: {
        facebook: String,
        instagram: String,
        twitter: String,
      },
      businessInfo: {
        registrationNumber: String,
        taxId: String,
        verificationDate: Date,
      },
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'shops',
  }
);

// Index for faster queries
shopSchema.index({ ownerId: 1 });
shopSchema.index({ category: 1 });
shopSchema.index({ isActive: 1 });
shopSchema.index({ createdAt: -1 });
shopSchema.index({ rating: -1 });

const Shop = mongoose.model('Shop', shopSchema);

module.exports = Shop;
