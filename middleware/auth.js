// JWT Authentication Middleware
const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'access_denied',
        message: 'No authentication token provided',
      });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({
            ok: false,
            error: 'token_expired',
            message: 'Token has expired',
          });
        }
        return res.status(403).json({
          ok: false,
          error: 'invalid_token',
          message: 'Invalid token',
        });
      }

      req.user = decoded; // Attach decoded token to request
      next();
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'server_error',
      message: error.message,
    });
  }
};

// Optional token middleware (doesn't fail if no token)
const optionalAuthToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, decoded) => {
        if (!err) {
          req.user = decoded;
        }
      });
    }
    next();
  } catch (error) {
    next();
  }
};

module.exports = { authenticateToken, optionalAuthToken };
