const http = require('http');

// Test de l'endpoint POST /api/messages/admin-messages
const testData = {
  subject: "Test Commande #123 ACCEPTÉE",
  content: "Ceci est un test de message admin depuis AlitogoShop",
  type: "order_notification",
  priority: "high",
  metadata: {
    orderId: 123,
    test: true
  }
};

const options = {
  hostname: '192.168.88.12',
  port: 4001,
  path: '/api/messages/admin-messages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(JSON.stringify(testData))
  }
};

console.log('🧪 Test de l\'endpoint messages admin...');
console.log('📤 Envoi des données:', JSON.stringify(testData, null, 2));

const req = http.request(options, (res) => {
  console.log(`📥 Status: ${res.statusCode}`);
  console.log(`📥 Headers:`, res.headers);

  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('📥 Réponse:', JSON.stringify(response, null, 2));

      if (response.ok) {
        console.log('✅ Test réussi ! Le message a été créé.');
      } else {
        console.log('❌ Test échoué:', response.message);
      }
    } catch (e) {
      console.log('❌ Erreur parsing réponse:', e.message);
      console.log('📄 Réponse brute:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Erreur requête:', e.message);
});

req.write(JSON.stringify(testData));
req.end();