const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const MAX_SEARCH_LEN = 100;

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// GET /api/patients
// DB-driven pagination + filtering. The row count and the page slice run in a
// single round trip via $transaction so they see the same snapshot — pagination
// metadata can never disagree with the returned rows.
router.get('/', authenticate, async (req, res) => {
  try {
    const { search, gender } = req.query;

    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(MAX_LIMIT, parsePositiveInt(req.query.limit, DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const where = {};
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim().slice(0, MAX_SEARCH_LEN);
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { phoneNumber: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (typeof gender === 'string' && gender && gender !== 'All') {
      where.gender = gender;
    }

    const [patients, totalPatients] = await prisma.$transaction([
      prisma.patient.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.patient.count({ where }),
    ]);

    res.json({
      success: true,
      patients,
      pagination: {
        page,
        limit,
        totalPatients,
        totalPages: Math.max(1, Math.ceil(totalPatients / limit)),
      },
    });
  } catch (error) {
    logger.error('Patient list failed', error);
    res.status(500).json({ error: 'Failed to fetch patients.' });
  }
});

// GET /api/patients/:id
// Single round trip — patient + appointments (newest first) + the doctor on
// each appointment. Powers the diagnostic-records page.
router.get('/:id', authenticate, async (req, res) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.params.id },
      include: {
        appointments: {
          orderBy: { appointmentDate: 'desc' },
          include: {
            doctor: {
              select: { id: true, name: true, specialization: true, department: true },
            },
          },
        },
      },
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    res.json(patient);
  } catch (error) {
    logger.error('Patient lookup failed', error, { id: req.params.id });
    res.status(500).json({ error: 'Failed to load patient.' });
  }
});

// POST /api/patients (Register patient)
// Reserved for front-desk and admin roles. Doctors view patients through
// the appointment worklist, never create them directly.
router.post('/', authenticate, authorize([ROLES.ADMIN, ROLES.RECEPTIONIST]), async (req, res) => {
  try {
    const { name, email, phoneNumber, age, gender, medicalHistory } = req.body;

    // INCONSISTENT VALIDATION:
    // Email is nullable in schema, but here we only check missing fields.
    // No regex to check telephone number formats, allowing random strings like "abc" to be stored!
    if (!name || !phoneNumber || !age || !gender) {
      return res.status(400).json({ error: 'Name, phoneNumber, age, and gender are required.' });
    }

    const patient = await prisma.patient.create({
      data: {
        name,
        email: email || null,
        phoneNumber,
        age: parseInt(age),
        gender,
        medicalHistory: medicalHistory || null, // Can be null, will crash UI without optional chaining
      },
    });

    res.status(201).json(patient);
  } catch (error) {
    res.status(500).json({ error: 'Failed to register patient', details: error.message });
  }
});

// DELETE /api/patients/:id — destructive, ADMIN only.
router.delete('/:id', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    await prisma.patient.delete({ where: { id } });

    res.json({ message: `Successfully deleted patient ${patient.name}` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete patient', details: error.message });
  }
});

module.exports = router;
