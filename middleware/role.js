// Role-based Authorization Middleware
const roleMiddleware = (...allowedRoles) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          ok: false,
          error: 'unauthorized',
          message: 'User not authenticated',
        });
      }

      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          ok: false,
          error: 'forbidden',
          message: `Only ${allowedRoles.join(', ')} can access this resource`,
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: 'server_error',
        message: error.message,
      });
    }
  };
};

module.exports = { roleMiddleware };
