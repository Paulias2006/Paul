/**
 * delete_all_user.js - Script pour supprimer tous les utilisateurs et leurs données associées
 * ATTENTION: Cette opération est IRRÉVERSIBLE !
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Import des modèles
const User = require('./models/User');
const Wallet = require('./models/Wallet');
const Transaction = require('./models/Transaction');
const Order = require('./models/Order');

async function deleteAllUsers() {
  try {
    console.log('🚨 ATTENTION: Cette opération va supprimer TOUS les utilisateurs et leurs données associées!');
    console.log('⏳ Connexion à MongoDB...');

    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/alitogopay');

    console.log('✅ Connecté à MongoDB');

    // Compter les documents avant suppression
    const userCount = await User.countDocuments();
    const walletCount = await Wallet.countDocuments();
    const transactionCount = await Transaction.countDocuments();
    const orderCount = await Order.countDocuments();

    console.log('\n📊 Données actuelles:');
    console.log(`   👥 Utilisateurs: ${userCount}`);
    console.log(`   💰 Portefeuilles: ${walletCount}`);
    console.log(`   💸 Transactions: ${transactionCount}`);
    console.log(`   📦 Commandes: ${orderCount}`);

    // Demander confirmation
    console.log('\n⚠️  Cette action va supprimer TOUTES les données utilisateur!');
    console.log('🔄 Suppression en cours...');

    // Supprimer dans l'ordre pour éviter les erreurs de contraintes
    const orderResult = await Order.deleteMany({});
    console.log(`✅ Commandes supprimées: ${orderResult.deletedCount}`);

    const transactionResult = await Transaction.deleteMany({});
    console.log(`✅ Transactions supprimées: ${transactionResult.deletedCount}`);

    const walletResult = await Wallet.deleteMany({});
    console.log(`✅ Portefeuilles supprimés: ${walletResult.deletedCount}`);

    const userResult = await User.deleteMany({});
    console.log(`✅ Utilisateurs supprimés: ${userResult.deletedCount}`);

    console.log('\n🎉 Suppression terminée avec succès!');
    console.log('📊 Résumé:');
    console.log(`   👥 Utilisateurs supprimés: ${userResult.deletedCount}`);
    console.log(`   💰 Portefeuilles supprimés: ${walletResult.deletedCount}`);
    console.log(`   💸 Transactions supprimées: ${transactionResult.deletedCount}`);
    console.log(`   📦 Commandes supprimées: ${orderResult.deletedCount}`);

  } catch (error) {
    console.error('❌ Erreur lors de la suppression:', error.message);
    process.exit(1);
  } finally {
    // Fermer la connexion
    await mongoose.connection.close();
    console.log('🔌 Connexion MongoDB fermée');
    process.exit(0);
  }
}

// Fonction principale
async function main() {
  console.log('🗑️  Script de suppression de tous les utilisateurs');
  console.log('=' .repeat(50));

  // Vérifier si on est en mode production
  if (process.env.NODE_ENV === 'production') {
    console.log('❌ Ce script ne peut pas être exécuté en production!');
    process.exit(1);
  }

  await deleteAllUsers();
}

// Exécuter le script
if (require.main === module) {
  main();
}

module.exports = { deleteAllUsers };
