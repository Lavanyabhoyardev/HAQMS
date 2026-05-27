const crypto = require('crypto');
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// Map (doctorId, dayIso) to a stable 64-bit signed integer for PostgreSQL's
// pg_advisory_xact_lock(bigint). SHA-1 is used as a fast hash (not for any
// security property); the 64-bit truncation collision probability is well
// below the operational concurrency of a hospital queue.
function checkinLockKey(doctorId, dayIso) {
  const hash = crypto.createHash('sha1')
    .update(`queue-checkin:${doctorId}:${dayIso}`)
    .digest();
  return hash.readBigInt64BE(0);
}

// GET /api/queue
router.get('/', authenticate, async (req, res) => {
  try {
    const { doctorId, status } = req.query;
    const where = {};
    if (doctorId) where.doctorId = doctorId;
    if (status) where.status = status;

    const tokens = await prisma.queueToken.findMany({
      where,
      include: { patient: true, doctor: true },
      orderBy: { createdAt: 'asc' },
    });

    res.json(tokens);
  } catch (error) {
    logger.error('Queue fetch failed', error);
    res.status(500).json({ error: 'Failed to retrieve queue.' });
  }
});

// POST /api/queue/checkin
//
// Concurrency-safe token allocation.
//
// Inside a single DB transaction we:
//   1. Acquire a transactional advisory lock keyed by (doctorId, day).
//      This serialises concurrent check-ins for the same doctor on the
//      same day across every API instance, while leaving other doctors
//      free to run in parallel.
//   2. Read the current max(tokenNumber) for that doctor today.
//   3. Insert tokenNumber = max + 1.
// The lock is automatically released when the transaction commits or
// rolls back, so an error inside the critical section can't leak a
// stale lock.
router.post('/checkin', authenticate, async (req, res) => {
  try {
    const { patientId, doctorId, appointmentId } = req.body;
    if (!patientId || !doctorId) {
      return res.status(400).json({ error: 'Patient and Doctor ID are required for check-in.' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayIso = today.toISOString().slice(0, 10);
    const lockKey = checkinLockKey(doctorId, dayIso);

    const newToken = await prisma.$transaction(async (tx) => {
      // Per (doctor, day) mutual exclusion. Other doctors do not contend.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const maxAggr = await tx.queueToken.aggregate({
        where: { doctorId, createdAt: { gte: today } },
        _max: { tokenNumber: true },
      });
      const nextTokenNumber = (maxAggr._max.tokenNumber || 0) + 1;

      return tx.queueToken.create({
        data: {
          tokenNumber: nextTokenNumber,
          // Pin tokenDate to the same `today` the advisory-lock key is
          // derived from, so the lock scope and the DB unique always align.
          tokenDate: today,
          patientId,
          doctorId,
          appointmentId: appointmentId || null,
          status: 'WAITING',
        },
        include: { patient: true, doctor: true },
      });
    });

    res.status(201).json({
      message: 'Checked in successfully. Token generated.',
      token: newToken,
    });
  } catch (error) {
    logger.error('Queue check-in failed', error, {
      patientId: req.body && req.body.patientId,
      doctorId: req.body && req.body.doctorId,
    });
    res.status(500).json({ error: 'Check-in failed.' });
  }
});

// PATCH /api/queue/:id
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const updatedToken = await prisma.queueToken.update({
      where: { id: req.params.id },
      data: { status },
      include: { patient: true, doctor: true },
    });

    res.json(updatedToken);
  } catch (error) {
    logger.error('Queue token update failed', error, { id: req.params.id });
    res.status(500).json({ error: 'Failed to update queue token.' });
  }
});

module.exports = router;
