const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const { signAccessToken } = require('../utils/jwt');

const router = express.Router();
const prisma = new PrismaClient();

// Public representation of a user. Anything not in this list — password hash,
// internal timestamps, ad-hoc columns — never leaves the server.
function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Audit trail for registration attempts. We log identity and role only —
    // never the password or any field that may carry a secret. The shared
    // logger applies a defensive redaction pass on `meta` as a second line of
    // defence in case future maintainers add additional fields here.
    logger.info('Registration attempt', { email, role: role || 'RECEPTIONIST' });

    // MISSING VALIDATION: Does not check if email is valid format or if password is strong
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: role || 'RECEPTIONIST',
      },
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: toPublicUser(user),
    });
  } catch (error) {
    logger.error('Registration failed', error, { email: req.body && req.body.email });
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Log the email for audit/anomaly detection (e.g. brute-force tracing),
    // but never the password. Even on failed attempts, logging the credential
    // would let any log reader replay it against another system.
    logger.info('Login attempt', { email });

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Token payload is intentionally minimal: id + role only. Display fields
    // (name, email) belong on the user resource fetched separately, not on
    // every Authorization header.
    const token = signAccessToken({ id: user.id, role: user.role });

    res.json({
      status: 'success',
      data: {
        token,
        user: toPublicUser(user),
      },
    });
  } catch (error) {
    logger.error('Login failed', error, { email: req.body && req.body.email });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/auth/me
// Returns current user details based on JWT
const { authenticate } = require('../middleware/auth');
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true },
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    logger.error('Failed to load current user', error, { userId: req.user && req.user.id });
    res.status(500).json({ error: 'Failed to retrieve user details.' });
  }
});

module.exports = router;
