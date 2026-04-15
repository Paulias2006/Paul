-- Migration: wallets table for alitogoshop database
-- Table des portefeuilles utilisateurs (pour tous les utilisateurs)
CREATE TABLE IF NOT EXISTS wallets (
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

-- Insérer automatiquement un portefeuille pour tous les utilisateurs existants
INSERT IGNORE INTO wallets (user_id, balance, total_earned, total_withdrawn)
SELECT id, 0.00, 0.00, 0.00 FROM users;

-- Trigger pour créer automatiquement un portefeuille lors de l'inscription d'un nouvel utilisateur
DELIMITER ;;
CREATE TRIGGER IF NOT EXISTS create_wallet_on_user_insert
AFTER INSERT ON users
FOR EACH ROW
BEGIN
  INSERT INTO wallets (user_id, balance, total_earned, total_withdrawn)
  VALUES (NEW.id, 0.00, 0.00, 0.00);
END;;
DELIMITER ;
