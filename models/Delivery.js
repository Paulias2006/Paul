/**
 * Delivery Model - Stockage des livraisons multi-etapes
 */
const mongoose = require('mongoose');

const deliverySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    order_id: { type: String, index: true },
    commande_id: { type: String },
    leg: {
      type: {
        type: String,
        default: null
      },
      index: Number,
      total: Number,
      from: {
        label: String,
        address: String,
        lat: Number,
        lng: Number
      },
      to: {
        label: String,
        address: String,
        lat: Number,
        lng: Number
      }
    },
    client: {
      id: String,
      name: String,
      phone: String,
      email: String,
      location: {
        lat: Number,
        lng: Number,
        address: String,
        region: String,
        city: String,
        district: String
      }
    },
    vendor: {
      id: String,
      name: String,
      location: {
        lat: Number,
        lng: Number
      },
      address: String
    },
    courier: {
      id: String,
      name: String,
      phone: String,
      acceptedAt: Date
    },
    product: {
      id: String,
      name: String,
      quantity: Number,
      options: String,
      photo: String
    },
    items: [
      {
        productId: String,
        name: String,
        quantity: Number,
        price: Number,
        photo: String
      }
    ],
    payment: {
      total: Number,
      product_amount: Number,
      delivery_fee: Number,
      status: String,
      paygate_reference: String
    },
    delivery_info: {
      distance: Number,
      mode: String,
      payment_mode: String
    },
    expiresAt: { type: Date, default: null },
    status: { type: String, default: 'pending' },
    source: { type: String, default: 'alitogoshop' }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'deliveries'
  }
);

deliverySchema.index({ 'client.id': 1 });
deliverySchema.index({ status: 1, created_at: -1 });
deliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Delivery', deliverySchema);
