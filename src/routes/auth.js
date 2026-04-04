const { Router } = require('express');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/db');
const { success, createError } = require('../utils/response');

const router = Router();

// ─── Password verification ────────────────────────────────────────────────────
// Matches the format written by seed.js: "scrypt:<salt>:<hash>"
function verifyPassword(plaintext, stored) {
  try {
    const [scheme, salt, hash] = stored.split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const derived = crypto.scryptSync(plaintext, salt, 64).toString('hex');
    // Timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(derived, 'hex'),
      Buffer.from(hash,    'hex')
    );
  } catch {
    return false;
  }
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return next(createError('VALIDATION_ERROR', 'email and password are required', 400));
    }

    // FIX: column is user_id, not id
    const result = await query(
      'SELECT user_id, email, brand_id, role, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (!result.rows.length) {
      return next(createError('INVALID_CREDENTIALS', 'Invalid email or password', 401));
    }

    const user = result.rows[0];

    // FIX: actually verify the password
    if (!verifyPassword(password, user.password_hash)) {
      return next(createError('INVALID_CREDENTIALS', 'Invalid email or password', 401));
    }

    // FIX: JWT payload uses user.user_id (not user.id which was undefined)
    const token = jwt.sign(
      { user_id: user.user_id, brand_id: user.brand_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '24h' }
    );

    return success(res, {
      brand_id:  user.brand_id,
      engine_id: null,
      token,
      user: {
        id:       user.user_id,
        email:    user.email,
        role:     user.role,
        brand_id: user.brand_id
      }
    });
  } catch (err) {
    next(createError('AUTH_FAILED', err.message, 500));
  }
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, brand_name } = req.body;
    if (!email || !password || !brand_name) {
      return next(createError('VALIDATION_ERROR', 'email, password, and brand_name are required', 400));
    }
    return next(createError('NOT_IMPLEMENTED', 'Registration not yet implemented', 501));
  } catch (err) {
    next(createError('REGISTER_FAILED', err.message, 500));
  }
});

module.exports = router;
