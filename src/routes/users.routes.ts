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

export default router;
