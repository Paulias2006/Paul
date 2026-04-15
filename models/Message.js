/**
 * Message Model for Admin Notifications
 */
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['order_notification', 'system_alert', 'payment_notification'],
      default: 'order_notification',
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    metadata: {
      // Weeshop order IDs are Mongo ObjectId strings.
      orderId: String,
      clientEmail: String,
      vendeurEmail: String,
      boutiqueNom: String,
      totalAmount: Number,
      status: String,
      // Localisation
      clientLat: Number,
      clientLng: Number,
      boutiqueLat: Number,
      boutiqueLng: Number,
      // Livreur
      courierId: String,
      rejectedBy: [
        {
          type: mongoose.Schema.Types.Mixed
        }
      ],
      courierAssignedAt: Date,
      deliveryStatus: {
        type: String,
        enum: ['assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled'],
        default: null
      },
      paymentStatus: String,
      paymentReference: String,
      paidAt: Date,
      courierFee: Number,
      delivery_fee: Number,
      leg_index: Number,
      leg_total: Number,
      leg_type: String,
      from_label: String,
      from_address: String,
      from_lat: Number,
      from_lng: Number,
      to_label: String,
      to_address: String,
      to_lat: Number,
      to_lng: Number,
      deliveredAt: Date,
      deliveryNotes: String,
      lastStatusUpdate: Date,
      items: [
        {
          productId: String,
          name: String,
          quantity: Number,
          price: Number,
          photo: String
        }
      ]
    },
    createdBy: {
      type: String,
      default: 'system',
    },
  },
  {
    timestamps: true,
    collection: 'messages',
  }
);

// Index for faster queries
messageSchema.index({ createdAt: -1 });
messageSchema.index({ isRead: 1 });
messageSchema.index({ type: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

messageSchema.pre('validate', function setOrderNotificationExpiry(next) {
  if (this.type === 'order_notification' && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
  next();
});

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
