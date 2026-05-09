import { Router } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../utils/db';
import { authenticateToken, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.use(authorize(['SUPER_ADMIN', 'OFFICE_STAFF', 'FIELD_WORKER']));

router.get('/', async (req, res) => {
  const jwtUserId = req.user!.userId;
  const jwtRole = req.user!.role;

  try {
    const whereClause = jwtRole === 'FIELD_WORKER' ? { createdById: jwtUserId } : {};
    const clients = await prisma.clientProfile.findMany({
      where: whereClause,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true } },
        createdByUser: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

router.post('/', async (req, res) => {
  const {
    firstName,
    lastName,
    phone,
    address,
    idProofType,
    idProofNumber,
    notes,
    type = 'CLIENT',
    fingerprintVerified = false,
    createdById: overrideCreatedById,
  } = req.body;

  const jwtUserId = req.user!.userId;
  const jwtRole = req.user!.role;

  let createdById = jwtUserId;
  if (overrideCreatedById && (jwtRole === 'SUPER_ADMIN' || jwtRole === 'OFFICE_STAFF')) {
    createdById = overrideCreatedById;
  }

  if (!firstName || !phone) {
    return res.status(400).json({ error: 'firstName and phone are required' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: `client_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          passwordHash: await bcrypt.hash('client@123', 10),
          role: 'CLIENT',
          firstName,
          lastName: lastName || '',
          phone,
        },
      });

      const client = await tx.clientProfile.create({
        data: {
          userId: user.id,
          type,
          address,
          idProofType,
          idProofNumber,
          notes,
          fingerprintVerified,
          createdById,
        },
        include: {
          user: { select: { firstName: true, lastName: true, phone: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'CLIENT',
          entityId: client.id,
          performedBy: createdById,
          details: { firstName, lastName, phone, type },
        },
      });

      return client;
    });

    res.status(201).json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Failed to create client' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const client = await prisma.clientProfile.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { firstName: true, lastName: true, phone: true } },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            performedBy: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch client' });
  }
});

router.put('/:id', authorize(['SUPER_ADMIN', 'OFFICE_STAFF']), async (req, res) => {
  const { address, idProofType, idProofNumber, notes, fingerprintVerified } = req.body;
  try {
    const client = await prisma.clientProfile.update({
      where: { id: req.params.id as string },
      data: { address, idProofType, idProofNumber, notes, fingerprintVerified },
      include: {
        user: { select: { firstName: true, lastName: true, phone: true } },
      },
    });
    res.json(client);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update client' });
  }
});

router.get('/:id/transactions', async (req, res) => {
  const { id } = req.params;
  try {
    const transactions = await prisma.transaction.findMany({
      where: { clientId: id },
      include: {
        performedBy: { select: { firstName: true, lastName: true } },
        office: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

export default router;
