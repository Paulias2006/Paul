#!/bin/bash

# ============================================================================
# setup.sh - Script de setup initial pour AlitogoPay
# ============================================================================
# Usage: bash setup.sh
# Crée les collections MongoDB et les indexes nécessaires

MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017/alitogopay}"
DB_NAME="${DB_NAME:-alitogopay}"

echo "🚀 Initialisation AlitogoPay Backend..."
echo "📍 MongoDB: $MONGODB_URI"

# Créer les collections et indexes
mongo "$MONGODB_URI" << EOJS

// ============================================================================
// USERS COLLECTION
// ============================================================================
db.createCollection("users", {
  validator: {
    \$jsonSchema: {
      bsonType: "object",
      required: ["email", "phone", "fullName", "passwordHash"],
      properties: {
        _id: { bsonType: "objectId" },
        email: {
          bsonType: "string",
          pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$",
          description: "Email de l'utilisateur"
        },
        phone: {
          bsonType: "string",
          pattern: "^[+]?[0-9]{10,15}$",
          description: "Numéro de téléphone"
        },
        fullName: {
          bsonType: "string",
          description: "Nom complet"
        },
        passwordHash: {
          bsonType: "string",
          description: "Hash du mot de passe (bcryptjs)"
        },
        role: {
          enum: ["buyer", "seller", "admin"],
          description: "Rôle utilisateur"
        },
        isEmailVerified: { bsonType: "bool" },
        isPhoneVerified: { bsonType: "bool" },
        isActive: { bsonType: "bool" },
        lastLogin: { bsonType: ["date", "null"] },
        createdAt: { bsonType: "date" },
        updatedAt: { bsonType: "date" }
      }
    }
  }
});

// Indexes pour users
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ phone: 1 }, { unique: true });
db.users.createIndex({ createdAt: -1 });
db.users.createIndex({ role: 1 });

console.log("✅ Collection 'users' créée avec indexes");

// ============================================================================
// WALLETS COLLECTION
// ============================================================================
db.createCollection("wallets");

db.wallets.createIndex({ userId: 1 }, { unique: true });
db.wallets.createIndex({ createdAt: -1 });
db.wallets.createIndex({ balance: 1 });

console.log("✅ Collection 'wallets' créée avec indexes");

// ============================================================================
// TRANSACTIONS COLLECTION
// ============================================================================
db.createCollection("transactions");

db.transactions.createIndex({ userId: 1 });
db.transactions.createIndex({ orderId: 1 });
db.transactions.createIndex({ identifier: 1 }, { unique: true, sparse: true });
db.transactions.createIndex({ paygateTxReference: 1 }, { sparse: true });
db.transactions.createIndex({ status: 1 });
db.transactions.createIndex({ createdAt: -1 });
db.transactions.createIndex({ "metadata.courierId": 1 }, { sparse: true });

console.log("✅ Collection 'transactions' créée avec indexes");

// ============================================================================
// SHOPS COLLECTION
// ============================================================================
db.createCollection("shops");

db.shops.createIndex({ ownerId: 1 });
db.shops.createIndex({ name: 1 });
db.shops.createIndex({ createdAt: -1 });

console.log("✅ Collection 'shops' créée avec indexes");

// ============================================================================
// PRODUCTS COLLECTION
// ============================================================================
db.createCollection("products");

db.products.createIndex({ shopId: 1 });
db.products.createIndex({ category: 1 });
db.products.createIndex({ createdAt: -1 });
db.products.createIndex({ price: 1 });

console.log("✅ Collection 'products' créée avec indexes");

// ============================================================================
// PAYMENT LOGS COLLECTION
// ============================================================================
db.createCollection("paymentlogs");

db.paymentlogs.createIndex({ transactionId: 1 });
db.paymentlogs.createIndex({ type: 1 });
db.paymentlogs.createIndex({ createdAt: -1 });

// TTL Index: Supprimer après 90 jours pour économiser de l'espace
db.paymentlogs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

console.log("✅ Collection 'paymentlogs' créée avec indexes");

// ============================================================================
// AFFICHAGE RÉCAPITULATIF
// ============================================================================
console.log("\n===============================================");
console.log("✅ AlitogoPay Setup Complété avec Succès!");
console.log("===============================================");
console.log("Collections créées:");
console.log("  • users");
console.log("  • wallets");
console.log("  • transactions");
console.log("  • shops");
console.log("  • products");
console.log("  • paymentlogs");
console.log("\nIndexes créés pour performance optimale.");
console.log("===============================================\n");

EOJS

# Vérifier si les collections ont été créées
echo "📊 Vérification des collections..."
mongo "$MONGODB_URI" --eval "db.getCollectionNames()"

echo ""
echo "✅ Setup terminé!"
echo "🚀 Vous pouvez maintenant démarrer: npm run dev"
