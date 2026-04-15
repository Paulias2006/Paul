const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'alitogoshop',
    multipleStatements: true
  });

  try {
    console.log('Running migrations...');

    const migrationPath = path.join(__dirname, '../models/migrations.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    const [results] = await connection.execute(sql);
    console.log('Migrations completed successfully');

    // Verify wallets
    const [rows] = await connection.execute('SELECT COUNT(*) as total_users FROM users; SELECT COUNT(*) as users_with_wallet FROM wallets;');
    console.log('Verification:');
    console.log('Total users:', rows[0][0].total_users);
    console.log('Users with wallet:', rows[1][0].users_with_wallet);

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await connection.end();
  }
}

migrate();
