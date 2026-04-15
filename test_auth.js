/**
 * Test script for AlitogoPay Authentication (Registration & Login)
 * This script tests the registration and login functionality of the backend API
 */

const axios = require('axios');
const mongoose = require('mongoose');
const User = require('./models/User');
const Wallet = require('./models/Wallet');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:4001';
const API_BASE = `${BASE_URL}/api/auth`;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/alitogopay_test';

// Test data
const testUser = {
  email: `test${Date.now()}@example.com`,
  phone: `+2250101${Math.floor(Math.random() * 900000) + 100000}`,
  fullName: 'Test User',
  password: 'TestPassword123!'
};

let serverProcess = null;
let accessToken = null;
let refreshToken = null;

// Utility functions
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const colors = {
    info: '\x1b[36m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m',
    reset: '\x1b[0m'
  };
  console.log(`${colors[type]}[${timestamp}] ${message}${colors.reset}`);
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanup() {
  try {
    log('🧹 Cleaning up test data...');

    // Remove test user and wallet
    const user = await User.findOne({ email: testUser.email });
    if (user) {
      await Wallet.deleteMany({ userId: user._id });
      await User.deleteOne({ _id: user._id });
      log('✅ Test user and wallet cleaned up', 'success');
    }
  } catch (error) {
    log(`❌ Error during cleanup: ${error.message}`, 'error');
  }
}

// Test functions
async function testRegistration() {
  log('📝 Testing user registration...');

  try {
    const response = await axios.post(`${API_BASE}/register`, testUser, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data.ok) {
      log('✅ Registration successful', 'success');
      log(`   User ID: ${response.data.user._id}`);
      log(`   Email: ${response.data.user.email}`);
      log(`   Tokens received: ${!!response.data.tokens.accessToken}`);

      accessToken = response.data.tokens.accessToken;
      refreshToken = response.data.tokens.refreshToken;

      return true;
    } else {
      log(`❌ Registration failed: ${response.data.message}`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ Registration error: ${error.response?.data?.message || error.message}`, 'error');
    return false;
  }
}

async function testDuplicateRegistration() {
  log('🔄 Testing duplicate registration (should fail)...');

  try {
    const response = await axios.post(`${API_BASE}/register`, testUser, {
      headers: { 'Content-Type': 'application/json' }
    });

    log('❌ Duplicate registration should have failed but succeeded', 'error');
    return false;
  } catch (error) {
    if (error.response?.status === 400 && error.response.data.error === 'user_exists') {
      log('✅ Duplicate registration correctly rejected', 'success');
      return true;
    } else {
      log(`❌ Unexpected error: ${error.response?.data?.message || error.message}`, 'error');
      return false;
    }
  }
}

async function testLogin() {
  log('🔐 Testing user login...');

  try {
    const response = await axios.post(`${API_BASE}/login`, {
      email: testUser.email,
      password: testUser.password
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data.ok) {
      log('✅ Login successful', 'success');
      log(`   User: ${response.data.user.fullName}`);
      log(`   Tokens received: ${!!response.data.tokens.accessToken}`);

      accessToken = response.data.tokens.accessToken;
      refreshToken = response.data.tokens.refreshToken;

      return true;
    } else {
      log(`❌ Login failed: ${response.data.message}`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ Login error: ${error.response?.data?.message || error.message}`, 'error');
    return false;
  }
}

async function testInvalidLogin() {
  log('🚫 Testing invalid login (wrong password)...');

  try {
    const response = await axios.post(`${API_BASE}/login`, {
      email: testUser.email,
      password: 'WrongPassword123!'
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    log('❌ Invalid login should have failed but succeeded', 'error');
    return false;
  } catch (error) {
    if (error.response?.status === 401 && error.response.data.error === 'invalid_credentials') {
      log('✅ Invalid login correctly rejected', 'success');
      return true;
    } else {
      log(`❌ Unexpected error: ${error.response?.data?.message || error.message}`, 'error');
      return false;
    }
  }
}

async function testGetCurrentUser() {
  log('👤 Testing get current user (protected route)...');

  try {
    const response = await axios.get(`${API_BASE}/me`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.ok) {
      log('✅ Get current user successful', 'success');
      log(`   User: ${response.data.user.fullName}`);
      log(`   Email verified: ${response.data.user.isEmailVerified}`);
      log(`   Wallet exists: ${!!response.data.wallet}`);
      return true;
    } else {
      log(`❌ Get current user failed: ${response.data.message}`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ Get current user error: ${error.response?.data?.message || error.message}`, 'error');
    return false;
  }
}

async function testTokenRefresh() {
  log('🔄 Testing token refresh...');

  try {
    const response = await axios.post(`${API_BASE}/refresh`, {
      refreshToken: refreshToken
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data.ok) {
      log('✅ Token refresh successful', 'success');
      log(`   New access token received: ${!!response.data.tokens.accessToken}`);

      accessToken = response.data.tokens.accessToken;
      refreshToken = response.data.tokens.refreshToken;

      return true;
    } else {
      log(`❌ Token refresh failed: ${response.data.message}`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ Token refresh error: ${error.response?.data?.message || error.message}`, 'error');
    return false;
  }
}

async function testLogout() {
  log('🚪 Testing logout...');

  try {
    const response = await axios.post(`${API_BASE}/logout`, {}, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.ok) {
      log('✅ Logout successful', 'success');
      return true;
    } else {
      log(`❌ Logout failed: ${response.data.message}`, 'error');
      return false;
    }
  } catch (error) {
    log(`❌ Logout error: ${error.response?.data?.message || error.message}`, 'error');
    return false;
  }
}

async function checkServerHealth() {
  log('🏥 Checking server health...');

  try {
    const response = await axios.get(`${BASE_URL}/health`);
    if (response.data.ok && response.data.database.connected) {
      log('✅ Server is healthy', 'success');
      return true;
    } else {
      log('❌ Server health check failed', 'error');
      return false;
    }
  } catch (error) {
    log(`❌ Health check error: ${error.message}`, 'error');
    return false;
  }
}

// Main test runner
async function runTests() {
  log('🚀 Starting AlitogoPay Authentication Tests');
  log('==========================================');

  let passedTests = 0;
  let totalTests = 0;

  try {
    // Connect to test database
    log('📊 Connecting to test database...');
    await mongoose.connect(MONGODB_URI);
    log('✅ Connected to test database', 'success');

    // Clean up any existing test data
    await cleanup();

    // Check server health
    totalTests++;
    if (await checkServerHealth()) passedTests++;

    // Test registration
    totalTests++;
    if (await testRegistration()) passedTests++;

    // Test duplicate registration
    totalTests++;
    if (await testDuplicateRegistration()) passedTests++;

    // Test login
    totalTests++;
    if (await testLogin()) passedTests++;

    // Test invalid login
    totalTests++;
    if (await testInvalidLogin()) passedTests++;

    // Test get current user
    totalTests++;
    if (await testGetCurrentUser()) passedTests++;

    // Test token refresh
    totalTests++;
    if (await testTokenRefresh()) passedTests++;

    // Test logout
    totalTests++;
    if (await testLogout()) passedTests++;

  } catch (error) {
    log(`💥 Test suite failed: ${error.message}`, 'error');
  } finally {
    // Clean up
    await cleanup();

    // Close database connection
    await mongoose.disconnect();
    log('🔌 Disconnected from test database', 'success');

    // Results
    log('==========================================');
    log(`📊 Test Results: ${passedTests}/${totalTests} tests passed`);

    if (passedTests === totalTests) {
      log('🎉 All tests passed! Authentication system is working correctly.', 'success');
      process.exit(0);
    } else {
      log('❌ Some tests failed. Please check the implementation.', 'error');
      process.exit(1);
    }
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  log('\n🛑 Received SIGINT, cleaning up...');
  await cleanup();
  await mongoose.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('\n🛑 Received SIGTERM, cleaning up...');
  await cleanup();
  await mongoose.disconnect();
  process.exit(0);
});

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(error => {
    log(`💥 Fatal error: ${error.message}`, 'error');
    process.exit(1);
  });
}

module.exports = { runTests };
