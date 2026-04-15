#!/bin/bash

# ============================================================================
# verify_installation.sh - Vérifier que tout est installé correctement
# ============================================================================

echo "======================================"
echo "🔍 Vérification Installation AlitogoPay"
echo "======================================"
echo ""

# Couleurs
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Compteurs
PASSED=0
FAILED=0

check_command() {
  if command -v $1 &> /dev/null; then
    echo -e "${GREEN}✅${NC} $1 installé"
    ((PASSED++))
  else
    echo -e "${RED}❌${NC} $1 NON trouvé"
    ((FAILED++))
  fi
}

check_file() {
  if [ -f "$1" ]; then
    echo -e "${GREEN}✅${NC} $1 existe"
    ((PASSED++))
  else
    echo -e "${RED}❌${NC} $1 MANQUANT"
    ((FAILED++))
  fi
}

check_dir() {
  if [ -d "$1" ]; then
    echo -e "${GREEN}✅${NC} $1 existe"
    ((PASSED++))
  else
    echo -e "${RED}❌${NC} $1 MANQUANT"
    ((FAILED++))
  fi
}

echo "═════════════════════════════════════"
echo "📦 Dépendances Node"
echo "═════════════════════════════════════"
check_command "node"
check_command "npm"

echo ""
echo "═════════════════════════════════════"
echo "🗄️  Base de Données"
echo "═════════════════════════════════════"
check_command "mongod"
check_command "mongo"

echo ""
echo "═════════════════════════════════════"
echo "📂 Fichiers et Répertoires"
echo "═════════════════════════════════════"

cd "$(dirname "$0")"

check_dir "node_modules"
check_dir "routes"
check_dir "models"
check_dir "middleware"
check_dir "services"

check_file ".env"
check_file "server.js"
check_file "db.js"
check_file "package.json"

echo ""
echo "═════════════════════════════════════"
echo "🔗 Routes API"
echo "═════════════════════════════════════"

check_file "routes/auth.js"
check_file "routes/users.js"
check_file "routes/wallet.js"
check_file "routes/pay.js"
check_file "routes/webhook.js"

echo ""
echo "═════════════════════════════════════"
echo "📋 Services"
echo "═════════════════════════════════════"

check_file "services/emailService.js"
check_file "services/walletService.js"

echo ""
echo "═════════════════════════════════════"
echo "📚 Documentation"
echo "═════════════════════════════════════"

check_file "API_DOCUMENTATION.md"
check_file "COMPLETE_INTEGRATION_GUIDE.md"
check_file ".env.example"

echo ""
echo "═════════════════════════════════════"
echo "🔒 AlitogoShop - Endpoints de Sync"
echo "═════════════════════════════════════"

if [ -f "../alitogoshop/api_payment_sync.php" ]; then
  echo -e "${GREEN}✅${NC} api_payment_sync.php existe"
  ((PASSED++))
else
  echo -e "${RED}❌${NC} api_payment_sync.php MANQUANT"
  ((FAILED++))
fi

echo ""
echo "═════════════════════════════════════"
echo "📊 RÉSUMÉ"
echo "═════════════════════════════════════"
echo -e "${GREEN}✅ Réussi: $PASSED${NC}"
echo -e "${RED}❌ Échoué: $FAILED${NC}"

if [ $FAILED -eq 0 ]; then
  echo ""
  echo -e "${GREEN}════════════════════════════════════${NC}"
  echo -e "${GREEN}✅ TOUT EST PRÊT!${NC}"
  echo -e "${GREEN}════════════════════════════════════${NC}"
  echo ""
  echo "Prochaines étapes:"
  echo "1. Configurer .env avec vos paramètres"
  echo "2. Lancer MongoDB: mongod"
  echo "3. Démarrer le serveur: npm run dev"
  echo "4. Tester l'API: http://localhost:4001/health"
  exit 0
else
  echo ""
  echo -e "${RED}════════════════════════════════════${NC}"
  echo -e "${RED}❌ PROBLÈMES DÉTECTÉS${NC}"
  echo -e "${RED}════════════════════════════════════${NC}"
  echo ""
  echo "Veuillez corriger les fichiers manquants ci-dessus"
  exit 1
fi
