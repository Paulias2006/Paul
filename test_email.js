const { sendOTPEmail } = require('./services/emailService');

async function testEmail() {
  console.log('🧪 Test de la fonctionnalité email...');

  try {
    const result = await sendOTPEmail(
      'togohpaul@gmail.com', // Remplacez par votre email de test
      'Utilisateur Test',
      '123456'
    );

    if (result) {
      console.log('✅ Email envoyé avec succès!');
    } else {
      console.log('❌ Échec de l\'envoi de l\'email!');
    }
  } catch (error) {
    console.error('❌ Erreur lors du test de l\'email:', error.message);
  }
}

testEmail();
