/**
 * emailService.js - Service d'envoi d'emails
 * Support: OTP, Verification, Notifications
 */

const nodemailer = require('nodemailer');
const path = require('path');

// Configuration email avec support multiple services
let transporter;

if (process.env.EMAIL_SERVICE === 'gmail') {
  // Configuration Gmail
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    },
    secure: true,
    port: 465,
    tls: {
      rejectUnauthorized: false
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100
  });
} else if (process.env.EMAIL_SERVICE === 'smtp') {
  // Configuration SMTP personnalisée
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD || process.env.EMAIL_APP_PASSWORD
    },
    tls: {
      rejectUnauthorized: false
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100
  });
} else if (process.env.EMAIL_SERVICE === 'sendgrid') {
  // Configuration SendGrid
  transporter = nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
    auth: {
      user: 'apikey',
      pass: process.env.SENDGRID_API_KEY
    },
    tls: {
      rejectUnauthorized: false
    }
  });
} else {
  // Configuration par défaut (local SMTP ou simulation)
  console.warn('⚠️ EMAIL_SERVICE non défini, utilisation du mode simulation');
  console.warn('💡 Configurez EMAIL_SERVICE=gmail ou EMAIL_SERVICE=smtp dans votre .env');

  // Mode simulation - ne pas créer de transporter réel
  transporter = {
    sendMail: async () => {
      console.log('📧 [SIMULATION] Email envoyé (service non configuré)');
      return true;
    }
  };
}

// Vérifier la connexion au démarrage (uniquement pour les vrais transporteurs)
if (transporter && typeof transporter.verify === 'function') {
  transporter.verify((error, success) => {
    if (error) {
      console.error('❌ Erreur de configuration email:', error.message);
      console.error('💡 Vérifiez EMAIL_USER et EMAIL_APP_PASSWORD dans votre .env');
      console.error('🔧 Assurez-vous que l\'authentification Gmail est activée');
    } else {
      console.log('✅ Service email configuré avec succès');
    }
  });
} else {
  console.warn('⚠️ EMAIL_SERVICE non défini, utilisation du mode simulation');
  console.warn('💡 Configurez EMAIL_SERVICE=gmail ou EMAIL_SERVICE=smtp dans votre .env');
}

/**
 * Envoyer un email OTP de vérification
 */
async function sendOTPEmail(toEmail, fullName, otpCode) {
  try {
    // Validation des paramètres
    if (!toEmail || !fullName || !otpCode) {
      throw new Error('Paramètres manquants: email, nom complet ou code OTP requis');
    }

    // Validation du format email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(toEmail)) {
      throw new Error('Format d\'email invalide');
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 30px; background: #f9f9f9; }
          .otp-box { background: white; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; border: 2px solid #667eea; }
          .otp-code { font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 5px; }
          .footer { padding: 20px; background: #f0f0f0; text-align: center; font-size: 12px; color: #999; border-radius: 0 0 8px 8px; }
          .warning { color: #ff6b6b; font-size: 14px; margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Vérification de votre compte</h1>
          </div>

          <div class="content">
            <p>Bonjour ${fullName},</p>
            <p>Vous avez demandé une vérification d'email pour AlitogoPay.</p>
            <p><strong>Votre code de vérification est:</strong></p>

            <div class="otp-box">
              <div class="otp-code">${otpCode}</div>
            </div>

            <p>Ce code expire dans <strong>10 minutes</strong>.</p>

            <div class="warning">
              ⚠️ Ne partagez ce code avec personne. AlitogoPay ne vous le demandera jamais par email ou SMS.
            </div>

            <p>Si vous n'avez pas demandé cette vérification, ignorez simplement cet email.</p>
          </div>

          <div class="footer">
            <p>&copy; 2026 AlitogoPay - Tous droits réservés</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `AlitogoPay <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: 'Code de vérification AlitogoPay',
      html: htmlContent
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email OTP envoyé avec succès à ${toEmail}`);
    return true;

  } catch (error) {
    console.error('❌ Erreur envoi email OTP:', {
      message: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode
    });

    // Gestion spécifique des erreurs courantes
    if (error.code === 'EAUTH') {
      console.error('❌ Erreur d\'authentification: Vérifiez EMAIL_USER et EMAIL_APP_PASSWORD');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('❌ Connexion refusée: Vérifiez la configuration SMTP');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('❌ Timeout: Problème de connexion réseau');
    }

    return false;
  }
}

/**
 * Envoyer un email de réinitialisation de mot de passe
 */
async function sendPasswordResetEmail(toEmail, fullName, resetToken, resetLink) {
  try {
    // Validation des paramètres
    if (!toEmail || !fullName || !resetToken || !resetLink) {
      throw new Error('Paramètres manquants pour l\'email de réinitialisation');
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 30px; background: #f9f9f9; }
          .button { display: inline-block; background: #f5576c; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
          .footer { padding: 20px; background: #f0f0f0; text-align: center; font-size: 12px; color: #999; border-radius: 0 0 8px 8px; }
          .warning { color: #ff6b6b; font-size: 14px; margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔒 Réinitialisation de mot de passe</h1>
          </div>

          <div class="content">
            <p>Bonjour ${fullName},</p>
            <p>Vous avez demandé une réinitialisation de votre mot de passe AlitogoPay.</p>
            <p>Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe:</p>

            <a href="${resetLink}" class="button">Réinitialiser mon mot de passe</a>

            <p>ou copiez ce lien:</p>
            <p style="background: white; padding: 10px; border-left: 4px solid #f5576c; word-break: break-all;">
              <code>${resetLink}</code>
            </p>

            <p><strong>Ce lien expire dans 1 heure</strong></p>

            <div class="warning">
              ⚠️ Si vous n'avez pas demandé cette réinitialisation, ignorez cet email. Votre compte reste sécurisé.
            </div>
          </div>

          <div class="footer">
            <p>&copy; 2026 AlitogoPay - Tous droits réservés</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `AlitogoPay <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: 'Réinitialisation de votre mot de passe AlitogoPay',
      html: htmlContent
    });

    console.log(`✅ Email réinitialisation envoyé à ${toEmail}`);
    return true;
  } catch (error) {
    console.error('❌ Erreur envoi email réinitialisation:', error);
    return false;
  }
}

/**
 * Envoyer une notification de paiement confirmé
 */
async function sendPaymentConfirmationEmail(toEmail, fullName, orderDetails) {
  try {
    // Validation des paramètres
    if (!toEmail || !fullName || !orderDetails) {
      throw new Error('Paramètres manquants pour l\'email de confirmation de paiement');
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #00d2fc 0%, #3677ff 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 30px; background: #f9f9f9; }
          .details { background: white; padding: 15px; border-left: 4px solid #00d2fc; margin: 20px 0; }
          .details p { margin: 8px 0; }
          .footer { padding: 20px; background: #f0f0f0; text-align: center; font-size: 12px; color: #999; border-radius: 0 0 8px 8px; }
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ Paiement confirmé</h1>
          </div>

          <div class="content">
            <p>Bonjour ${fullName},</p>
            <p>Votre paiement a été reçu avec succès!</p>

            <div class="details">
              <p><strong>Détails du paiement:</strong></p>
              <p>Montant: <strong>${orderDetails.amount} XOF</strong></p>
              <p>Commande: <strong>#${orderDetails.orderId}</strong></p>
              <p>Date: ${new Date(orderDetails.date).toLocaleDateString('fr-FR')}</p>
              <p>Méthode: <strong>${orderDetails.method}</strong></p>
              ${orderDetails.reference ? `<p>Référence: <strong>${orderDetails.reference}</strong></p>` : ''}
            </div>

            <p>Votre commande est maintenant confirmée et sera traitée rapidement.</p>
            <p>Vous pouvez suivre l'état de votre commande sur votre tableau de bord AlitogoPay.</p>
          </div>

          <div class="footer">
            <p>&copy; 2026 AlitogoPay - Tous droits réservés</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `AlitogoPay <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `Paiement confirmé - Commande #${orderDetails.orderId}`,
      html: htmlContent
    });

    console.log(`✅ Email confirmation paiement envoyé à ${toEmail}`);
    return true;
  } catch (error) {
    console.error('❌ Erreur envoi email confirmation:', error);
    return false;
  }
}

/**
 * Envoyer notification à un administrateur
 */
async function sendAdminNotification(subject, content) {
  try {
    // Validation des paramètres
    if (!subject || !content) {
      throw new Error('Paramètres manquants pour la notification admin');
    }

    const adminEmail = process.env.ADMIN_EMAIL || 'alitogoshop2@gmail.com';

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #333; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #999; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Notification Admin AlitogoPay</h2>
          </div>
          <div class="content">
            ${content}
          </div>
          <div class="footer">
            <p>Message automatique - Ne pas répondre</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `AlitogoPay <${process.env.EMAIL_USER}>`,
      to: adminEmail,
      subject: `[ADMIN] ${subject}`,
      html: htmlContent
    });

    console.log(`✅ Notification admin envoyée`);
    return true;
  } catch (error) {
    console.error('❌ Erreur envoi notification admin:', error);
    return false;
  }
}

module.exports = {
  sendOTPEmail,
  sendPasswordResetEmail,
  sendPaymentConfirmationEmail,
  sendAdminNotification
};
