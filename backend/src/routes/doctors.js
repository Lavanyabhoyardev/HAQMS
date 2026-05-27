const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

const MAX_SEARCH_LEN = 100;

// GET /api/doctors
// Doctor search & filter. All user input flows through Prisma's typed query
// builder, which parameterises every value — no string interpolation, no
// $queryRawUnsafe. The response shape (bare array) is preserved.
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, specialization } = req.query;
    const where = {};

    if (typeof search === 'string' && search.trim()) {
      // Reject pathological lengths up front — bounded input keeps the
      // ILIKE plan cheap and removes a DOS surface.
      const term = search.trim().slice(0, MAX_SEARCH_LEN);
      where.name = { contains: term, mode: 'insensitive' };
    }

    if (typeof specialization === 'string' && specialization && specialization !== 'All') {
      where.specialization = specialization.slice(0, MAX_SEARCH_LEN);
    }

    const doctors = await prisma.doctor.findMany({ where });
    res.json(doctors);
  } catch (error) {
    logger.error('Doctor search failed', error);
    res.status(500).json({ error: 'Failed to load doctors.' });
  }
});

// GET /api/doctors/stats
// All four aggregates are independent — fan out with Promise.all so wall
// time is ~max(query) instead of sum(queries).
router.get('/stats', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
  try {
    const start = Date.now();

    const [totalDoctors, surgeonsCount, averageFee, highestExperience] = await Promise.all([
      prisma.doctor.count(),
      prisma.doctor.count({ where: { department: 'Surgery' } }),
      prisma.doctor.aggregate({ _avg: { consultationFee: true } }),
      prisma.doctor.aggregate({ _max: { experience: true } }),
    ]);

    res.json({
      success: true,
      data: {
        total: totalDoctors,
        surgeons: surgeonsCount,
        averageFee: Math.round(averageFee._avg.consultationFee || 0),
        maxExperience: highestExperience._max.experience || 0,
      },
      debugInfo: {
        executionTimeMs: Date.now() - start,
      },
    });
  } catch (error) {
    logger.error('Doctor stats failed', error);
    res.status(500).json({ error: 'Failed to load doctor stats.' });
  }
});

// GET /api/doctors/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const doctor = await prisma.doctor.findUnique({
      where: { id: req.params.id },
    });

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    res.json(doctor);
  } catch (error) {
    logger.error('Doctor lookup failed', error, { id: req.params.id });
    res.status(500).json({ error: 'Failed to load doctor.' });
  }
});

module.exports = router;
