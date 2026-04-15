// ==================== MongoDB Database Connection ====================
const mongoose = require('mongoose');

// ==================== Import Models ====================
const Wallet = require('./models/Wallet');
const Transaction = require('./models/Transaction');
const User = require('./models/User');
const Delivery = require('./models/Delivery');

const normalizeOrderId = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const buildOrderIdOr = (value) => {
  const normalized = normalizeOrderId(value);
  if (!normalized) return [];
  const candidates = [{ orderId: normalized }];
  if (/^\d+$/.test(normalized)) {
    candidates.push({ orderId: Number(normalized) });
  }
  return candidates;
};

const toObjectIdOrNull = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return mongoose.Types.ObjectId.isValid(raw) ? raw : null;
};

// ==================== Database Class ====================
class Database {
  constructor() {
    this.connected = false;
  }

  // ==================== CONNECT ====================
  async connect() {
    try {
      // Vérification des variables d’environnement
      if (!process.env.MONGODB_URI) {
        console.warn('⚠️ MONGODB_URI non défini, utilisation de MongoDB local');
      }

      const mongoUrl =
        process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/alitogopay';

      // ✅ Connexion moderne (SANS options obsolètes)
      await mongoose.connect(mongoUrl);

      this.connected = true;

      console.log('✅ MongoDB connecté avec succès');
      console.log(`📍 Base de données : ${mongoose.connection.name}`);
    } catch (error) {
      console.error('❌ Erreur de connexion MongoDB :', error.message);
      process.exit(1);
    }
  }

  // ==================== TRANSACTIONS ====================

  async createTransaction(data) {
    try {
      const normalizedOrderId = normalizeOrderId(data.order_id || data.orderId);
      const transaction = new Transaction({
        orderId: normalizedOrderId || null,
        // accept client_id or user_id keys (from different callers)
        userId: toObjectIdOrNull(data.client_id || data.user_id || data.userId),
        shopId: toObjectIdOrNull(data.boutique_id || data.shop_id || data.shopId),
        type: data.type || 'payment',
        amount: data.amount,
        currency: 'XOF',
        status: data.status || 'pending',
        identifier: data.identifier,
        paymentMethod: data.network || null,
        phoneNumber: data.client_phone || null,
        description: data.description || '',
        qrToken: data.qr_token || null,
        expiresAt: data.expires_at || null,
        metadata: Object.assign({}, data.metadata || {}, {
          orderId: normalizedOrderId || null,
          clientIdRaw: data.client_id || data.user_id || data.userId || null,
          boutiqueIdRaw: data.boutique_id || data.shop_id || data.shopId || null,
          productAmount: data.product_amount || null,
          transportFee: data.transport_fee || null
        })
      });

      return await transaction.save();
    } catch (error) {
      console.error('❌ Erreur création transaction :', error);
      throw error;
    }
  }

  async findTransaction(query) {
    try {
      const search = {};

      if (query.id) search._id = query.id;
      if (query.identifier) search.identifier = query.identifier;
      if (query.paygate_tx_reference)
        search.paygateTxReference = query.paygate_tx_reference;
      if (query.order_id || query.orderId) {
        const candidates = buildOrderIdOr(query.order_id || query.orderId);
        if (candidates.length === 1) search.orderId = candidates[0].orderId;
        else if (candidates.length > 1) search.$or = candidates;
      }

      return await Transaction.findOne(search);
    } catch (error) {
      console.error('❌ Erreur recherche transaction :', error);
      throw error;
    }
  }

  async updateTransaction(id, data) {
    try {
      const update = {};

      if (data.status) update.status = data.status;
      if (data.paygate_tx_reference)
        update.paygateTxReference = data.paygate_tx_reference;
      if (data.payment_reference)
        update.paymentReference = data.payment_reference;
      if (data.payment_method)
        update.paymentMethod = data.payment_method;
      if (data.status === 'success' || data.status === 'completed')
        update.completedAt = new Date();

      return await Transaction.findByIdAndUpdate(id, update, {
        new: true,
      });
    } catch (error) {
      console.error('❌ Erreur mise à jour transaction :', error);
      throw error;
    }
  }

  async getTransactionHistory(limit = 50) {
    try {
      return await Transaction.find()
        .sort({ createdAt: -1 })
        .limit(limit);
    } catch (error) {
      console.error('❌ Erreur historique transactions :', error);
      throw error;
    }
  }

  async checkDuplicateTransaction(orderId) {
    try {
      const normalized = normalizeOrderId(orderId);
      if (!normalized) return null;
      const candidates = buildOrderIdOr(normalized);
      return await Transaction.findOne({
        ...(candidates.length > 1
          ? { $or: candidates }
          : { orderId: normalized }),
        status: { $in: ['pending', 'processing', 'completed'] },
      }).sort({ createdAt: -1 });
    } catch (error) {
      console.error('❌ Erreur vérification doublon :', error);
      throw error;
    }
  }

  // ==================== WALLET ====================

  async getWallet(userId) {
    try {
      let wallet = await Wallet.findOne({ userId });

      if (!wallet) {
        wallet = new Wallet({
          userId,
          balance: 0,
          currency: 'XOF',
          totalIncome: 0,
          totalExpense: 0,
        });
        await wallet.save();
        console.log(`✅ Wallet créé automatiquement pour utilisateur ${userId}`);
      }

      return wallet;
    } catch (error) {
      console.error('❌ Erreur récupération wallet :', error);
      throw error;
    }
  }

  // Créer un wallet pour un nouvel utilisateur
  async createWallet(userId) {
    try {
      let wallet = await Wallet.findOne({ userId });
      
      if (wallet) {
        console.log(`⚠️ Wallet déjà existant pour ${userId}`);
        return wallet;
      }

      wallet = new Wallet({
        userId,
        balance: 0,
        currency: 'XOF',
        totalIncome: 0,
        totalExpense: 0,
      });
      
      await wallet.save();
      console.log(`✅ Wallet créé pour nouvel utilisateur ${userId}`);
      return wallet;
    } catch (error) {
      console.error('❌ Erreur création wallet:', error);
      throw error;
    }
  }

  async updateWalletBalance(userId, amount) {
    try {
      return await Wallet.findOneAndUpdate(
        { userId },
        {
          $inc: {
            balance: amount,
            totalIncome: amount > 0 ? amount : 0,
            totalExpense: amount < 0 ? Math.abs(amount) : 0,
          },
          $set: { lastTransactionDate: new Date() },
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      console.error('❌ Erreur mise à jour wallet :', error);
      throw error;
    }
  }

  async creditWallet(userId, amount) {
    return this.updateWalletBalance(userId, amount);
  }

  async debitWallet(userId, amount) {
    const wallet = await Wallet.findOne({ userId });

    if (!wallet || wallet.balance < amount) {
      throw new Error('Solde insuffisant');
    }

    return this.updateWalletBalance(userId, -amount);
  }

  // ==================== LOGS ====================

  async createPaymentLog(data) {
    console.log(`[PAYMENT LOG] ${data.type}`, data.payload || {});
    return true;
  }

  // ==================== DELIVERIES ====================

  async createDelivery(data) {
    try {
      const delivery = new Delivery(data);
      return await delivery.save();
    } catch (error) {
      console.error('❌ Erreur création livraison :', error);
      throw error;
    }
  }

  async findDelivery(query) {
    try {
      return await Delivery.findOne(query);
    } catch (error) {
      console.error('❌ Erreur recherche livraison :', error);
      throw error;
    }
  }

  async findAllDeliveries(filter) {
    try {
      return await Delivery.find(filter || {}).sort({ created_at: -1 });
    } catch (error) {
      console.error('❌ Erreur listing livraisons :', error);
      throw error;
    }
  }

  async updateDelivery(filter, data) {
    try {
      return await Delivery.findOneAndUpdate(filter, data, { new: true });
    } catch (error) {
      console.error('❌ Erreur mise à jour livraison :', error);
      throw error;
    }
  }

  // ==================== UTILS ====================

  async close() {
    if (this.connected) {
      await mongoose.disconnect();
      this.connected = false;
      console.log('🔌 MongoDB déconnecté');
    }
  }

  async healthCheck() {
    try {
      await mongoose.connection.db.admin().ping();
      return true;
    } catch {
      return false;
    }
  }
}

// ==================== EXPORT SINGLETON ====================
const db = new Database();
module.exports = db;
