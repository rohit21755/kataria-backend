import { Router } from 'express';
import prisma from '../utils/db';
import { authenticateToken, authorize } from '../middleware/auth.middleware';

const router = Router();

// Only Super Admin and Office Staff can manage users
router.use(authenticateToken);
router.use(authorize(['SUPER_ADMIN', 'OFFICE_STAFF']));

router.get('/', async (req, res) => {
  const users = await prisma.user.findMany({
    select: { 
      id: true, username: true, role: true, firstName: true, lastName: true, isActive: true,
      deviceFingerprints: { select: { id: true } },
      biometricFingerprints: { select: { id: true } }
    }
  });
  res.json(users);
});

import bcrypt from 'bcrypt';

router.post('/', async (req, res) => {
  const { username, password, role, firstName, lastName, phone } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password || 'Kataria@123', 10);
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        role,
        firstName,
        lastName,
        phone,
      },
      select: { 
        id: true, username: true, role: true, firstName: true, lastName: true, isActive: true,
        deviceFingerprints: { select: { id: true } },
        biometricFingerprints: { select: { id: true } }
      }
    });
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ error: 'Username already exists or invalid data' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { firstName, lastName, phone, isActive, role } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id },
      data: { firstName, lastName, phone, isActive, role },
      select: { id: true, username: true, role: true, firstName: true, lastName: true, isActive: true }
    });
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update user' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        include: { clientProfile: true },
      });

      if (!user) {
        throw new Error('User not found');
      }

      if (user.clientProfile) {
        const clientProfile = user.clientProfile;

        await tx.ledgerEntry.deleteMany({
          where: { userId: user.id },
        });

        const txs = await tx.transaction.findMany({
          where: { clientId: clientProfile.id },
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

        await tx.clientProfile.delete({
          where: { id: clientProfile.id },
        });
      }

      await tx.deviceFingerprint.deleteMany({ where: { userId: id } });
      await tx.biometricFingerprint.deleteMany({ where: { userId: id } });
      await tx.ledgerEntry.deleteMany({ where: { userId: id } });

      await tx.user.delete({ where: { id } });
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error: any) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Failed to delete user' });
  }
});

router.post('/:id/reset-password', authorize(['SUPER_ADMIN']), async (req, res) => {
  const id = req.params.id as string;
  const { password } = req.body;

  if (!password || password.trim() === '') {
    return res.status(400).json({ error: 'Password is required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
    res.json({ message: 'Password updated successfully' });
  } catch (error: any) {
    console.error(error);
    res.status(400).json({ error: 'Failed to update password' });
  }
});

router.get('/by-username/:username', async (req, res) => {
  const username = req.params.username as string;
  try {
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, firstName: true, lastName: true, role: true }
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error: any) {
    res.status(400).json({ error: 'Failed to look up user' });
  }
});

export default router;

