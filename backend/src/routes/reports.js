const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/reports/doctor-stats
//
// Previously: O(doctors) loop, 5 sequential queries per doctor, plus an
// artificial 80 ms setTimeout per iteration. For N doctors: 1 + 5N queries
// and N * 80 ms forced latency.
//
// Now: 3 parallel queries total, regardless of doctor count.
//   1. doctor.findMany                — base list + consultationFee
//   2. appointment.groupBy by (doctorId, status)  — counts in one pass
//   3. queueToken.groupBy by doctorId (today)     — today's queue size
// Results are stitched together in memory in O(N) without further DB I/O.
router.get('/doctor-stats', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
  try {
    const start = Date.now();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [doctors, apptGroups, queueGroups] = await Promise.all([
      prisma.doctor.findMany(),
      prisma.appointment.groupBy({
        by: ['doctorId', 'status'],
        _count: { _all: true },
      }),
      prisma.queueToken.groupBy({
        by: ['doctorId'],
        where: { createdAt: { gte: today } },
        _count: { _all: true },
      }),
    ]);

    // Index group rows by doctorId for O(1) lookup during assembly.
    const apptByDoctor = new Map();
    for (const g of apptGroups) {
      const row = apptByDoctor.get(g.doctorId) || { total: 0, completed: 0, cancelled: 0 };
      const n = g._count._all;
      row.total += n;
      if (g.status === 'COMPLETED') row.completed += n;
      else if (g.status === 'CANCELLED') row.cancelled += n;
      apptByDoctor.set(g.doctorId, row);
    }

    const queueByDoctor = new Map();
    for (const g of queueGroups) {
      queueByDoctor.set(g.doctorId, g._count._all);
    }

    const reportData = doctors.map((doc) => {
      const a = apptByDoctor.get(doc.id) || { total: 0, completed: 0, cancelled: 0 };
      return {
        id: doc.id,
        name: doc.name,
        specialization: doc.specialization,
        department: doc.department,
        totalAppointments: a.total,
        completedAppointments: a.completed,
        cancelledAppointments: a.cancelled,
        todayQueueSize: queueByDoctor.get(doc.id) || 0,
        revenue: a.completed * doc.consultationFee,
      };
    });

    res.json({
      success: true,
      timeTakenMs: Date.now() - start,
      data: reportData,
    });
  } catch (error) {
    logger.error('Doctor-stats report failed', error);
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

module.exports = router;
