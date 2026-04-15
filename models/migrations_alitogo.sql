-- Migration: payment tables for alitogo database
-- Migration: create ap_transactions and ap_payment_logs for MySQL
CREATE TABLE IF NOT EXISTS ap_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT DEFAULT NULL COMMENT 'ID de la commande AlitogoShop',
  boutique_id INT DEFAULT NULL COMMENT 'ID de la boutique vendeur',
  client_id INT DEFAULT NULL COMMENT 'ID du client acheteur',
  client_phone VARCHAR(32) DEFAULT NULL COMMENT 'Téléphone client pour paiement',
  amount DECIMAL(12,2) DEFAULT 0 COMMENT 'Montant du paiement',
  identifier VARCHAR(128) DEFAULT NULL COMMENT 'Identifiant unique ATG-XXXX',
  paygate_tx_reference VARCHAR(128) DEFAULT NULL COMMENT 'Référence PayGateGlobal',
  network VARCHAR(32) DEFAULT NULL COMMENT 'Réseau mobile (TMoney/Moov)',
  payment_method VARCHAR(32) DEFAULT NULL COMMENT 'Méthode de paiement',
  status VARCHAR(32) DEFAULT 'pending' COMMENT 'Statut: pending/registered/success/failed',
  description TEXT COMMENT 'Description du paiement',
  qr_token VARCHAR(255) DEFAULT NULL COMMENT 'Token QR pour validation',
  expires_at DATETIME DEFAULT NULL COMMENT 'Expiration du QR',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Date de création',
  updated_at DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP COMMENT 'Date de mise à jour',
  INDEX idx_order_id (order_id),
  INDEX idx_status (status),
  INDEX idx_identifier (identifier),
  INDEX idx_paygate_ref (paygate_tx_reference),
  INDEX idx_qr_token (qr_token),
  INDEX idx_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS ap_payment_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT DEFAULT NULL COMMENT 'ID de la transaction liée',
  type VARCHAR(32) NOT NULL COMMENT 'Type: request/response/webhook/error',
  endpoint VARCHAR(255) DEFAULT NULL COMMENT 'Endpoint appelé',
  payload LONGTEXT COMMENT 'Payload JSON complet',
  status_code INT DEFAULT NULL COMMENT 'Code de statut HTTP',
  error_message TEXT DEFAULT NULL COMMENT 'Message d\'erreur',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT 'Date du log',
  INDEX idx_transaction_id (transaction_id),
  INDEX idx_type (type),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (transaction_id) REFERENCES ap_transactions(id) ON DELETE SET NULL
);

-- Table des portefeuilles utilisateurs pour paiements (dans alitogo)
CREATE TABLE IF NOT EXISTS ap_wallets (
  id INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT(10) UNSIGNED NOT NULL COMMENT 'ID de l\'utilisateur (vendeur ou acheteur)',
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Solde disponible pour retraits',
  total_earned DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Total gagné depuis le début',
  total_withdrawn DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Total retiré depuis le début',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user (user_id),
  INDEX idx_user_id (user_id),
  INDEX idx_balance (balance),
  INDEX idx_created_at (created_at)
);
