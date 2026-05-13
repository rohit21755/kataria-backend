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
    createdAt,
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

  let customDate: Date | null = null;
  if (createdAt) {
    const parsedDate = new Date(createdAt);
    if (!isNaN(parsedDate.getTime())) {
      customDate = parsedDate;
      if (typeof createdAt === 'string' && createdAt.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
        const now = new Date();
        customDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      }
    }
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
          createdAt: customDate || undefined,
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
          createdAt: customDate || undefined,
        },
        include: {
          user: { select: { firstName: true, lastName: true, phone: true } },
        },
      });

      const { openingBalance, openingBalanceType } = req.body;
      if (openingBalance && openingBalanceType) {
        const bal = Number(openingBalance);
        if (bal > 0) {
          const isCredit = openingBalanceType === 'CREDIT';
          await tx.ledgerEntry.create({
            data: {
              userId: user.id,
              credit: isCredit ? bal : 0,
              debit: isCredit ? 0 : bal,
              balanceAfter: isCredit ? bal : -bal,
              createdAt: customDate || undefined,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'CLIENT',
          entityId: client.id,
          performedBy: createdById,
          details: { firstName, lastName, phone, type, openingBalance, openingBalanceType },
          createdAt: customDate || undefined,
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
  const { address, idProofType, idProofNumber, notes, fingerprintVerified, firstName, lastName, phone } = req.body;
  try {
    const client = await prisma.clientProfile.update({
      where: { id: req.params.id as string },
      data: { 
        address, 
        idProofType, 
        idProofNumber, 
        notes, 
        fingerprintVerified,
        user: {
          update: {
            firstName: firstName !== undefined ? firstName : undefined,
            lastName: lastName !== undefined ? lastName : undefined,
            phone: phone !== undefined ? phone : undefined,
          }
        }
      },
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

router.delete('/:id', authorize(['SUPER_ADMIN', 'OFFICE_STAFF']), async (req, res) => {
  const id = req.params.id as string;
  try {
    await prisma.$transaction(async (tx) => {
      const client = await tx.clientProfile.findUnique({
        where: { id },
        include: { user: true },
      });

      if (!client) {
        throw new Error('Client not found');
      }

      await tx.ledgerEntry.deleteMany({
        where: { userId: client.userId },
      });

      const txs = await tx.transaction.findMany({
        where: { clientId: id },
      });

      const txIds = txs.map(t => t.id);

      if (txIds.length > 0) {
        await tx.ledgerEntry.deleteMany({
          where: { transactionId: { in: txIds } },
        });
        await tx.transaction.deleteMany({
          where: { id: { in: txIds } },
        });
      }

      await tx.deviceFingerprint.deleteMany({ where: { userId: client.userId } });
      await tx.biometricFingerprint.deleteMany({ where: { userId: client.userId } });

      await tx.clientProfile.delete({
        where: { id },
      });

      await tx.user.delete({
        where: { id: client.userId },
      });
    });

    res.json({ message: 'Client deleted successfully' });
  } catch (error: any) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Failed to delete client' });
  }
});

export default router;
