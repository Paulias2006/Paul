const dotenv = require('dotenv');

// Load environment variables FIRST
dotenv.config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const db = require('./db');

// Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'MONGODB_URI'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('💡 Please check your .env file and ensure all required variables are set');
  process.exit(1);
}

const app = express();

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API
  crossOriginEmbedderPolicy: false
}));

// CORS Configuration
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:8080')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (allowedOrigins.includes(origin) || (process.env.NODE_ENV !== 'production' && isLocalhostOrigin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};
app.use(cors(corsOptions));

// Body Parser with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`📨 ${req.method} ${req.path} - ${req.ip}`);

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`📤 ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });

  next();
});

// Import routes
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const productsRoutes = require('./routes/products');
const shopsRoutes = require('./routes/shops');
const payRoutes = require('./routes/pay');
const walletRoutes = require('./routes/wallet');
const webhookRoutes = require('./routes/webhook');
const scanRoutes = require('./routes/scan');
const deliveryRoutes = require('./routes/delivery');
const courierRoutes = require('./routes/courier');
const messageRoutes = require('./routes/messages');
const payoutsRoutes = require('./routes/payouts');
const adminRoutes = require('./routes/admin');

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/shops', shopsRoutes);
app.use('/api/pay', payRoutes);
app.use('/api/wallet', walletRoutes);
// Use raw body parser for webhooks so we can verify signatures against the raw payload
app.use('/api/webhook', express.raw({ type: '*/*', limit: '10mb' }));
app.use('/api/webhook', webhookRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/courier', courierRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/payouts', payoutsRoutes);
app.use('/api/admin', adminRoutes);

// Health check endpoints
app.get('/', (req, res) => res.json({
  ok: true,
  service: 'Weedelivred Backend',
  version: '2.0.0',
  environment: process.env.NODE_ENV || 'development',
  timestamp: new Date(),
  uptime: process.uptime()
}));

app.get('/health', async (req, res) => {
  try {
    const dbHealthy = await db.healthCheck();
    const status = dbHealthy ? 'healthy' : 'unhealthy';
    const statusCode = dbHealthy ? 200 : 503;

    res.status(statusCode).json({
      ok: dbHealthy,
      status: status,
      service: 'Weedelivred Backend',
      database: {
        connected: dbHealthy,
      },
      timestamp: new Date(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      status: 'unhealthy',
      service: 'Weedelivred Backend',
      error: error.message,
      timestamp: new Date(),
      uptime: process.uptime()
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'not_found',
    message: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      ok: false,
      error: 'validation_error',
      message: 'Invalid data provided',
      details: err.errors
    });
  }

  // Mongoose cast error
  if (err.name === 'CastError') {
    return res.status(400).json({
      ok: false,
      error: 'invalid_id',
      message: 'Invalid ID format'
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      ok: false,
      error: 'invalid_token',
      message: 'Invalid authentication token'
    });
  }

  // Default error response
  res.status(500).json({
    ok: false,
    error: 'server_error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Initialize database and start server
const startServer = async () => {
  try {
    console.log('🚀 Starting Weedelivred Backend...');

    // Connect to MongoDB
    await db.connect();

    const port = process.env.PORT || 4001;
    const server = app.listen(port, () => {
      console.log(`\n✅ Weedelivred Backend running successfully!`);
      console.log(`📍 Server: http://localhost:${port}`);
      console.log(`🏥 Health Check: http://localhost:${port}/health`);
      console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📊 Database: Connected to MongoDB\n`);
    });

    // Handle server errors
    server.on('error', (error) => {
      console.error('❌ Server error:', error);
      process.exit(1);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      await db.close();
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      await db.close();
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// Start the server
startServer();

module.exports = app;

