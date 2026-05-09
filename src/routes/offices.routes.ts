import { Router } from 'express';
import prisma from '../utils/db';
import { authenticateToken, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const offices = await prisma.office.findMany({
      include: {
        _count: { select: { users: true, transactions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(offices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch offices' });
  }
});

router.post('/', authorize(['SUPER_ADMIN']), async (req, res) => {
  const { name, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Office name required' });
  try {
    const office = await prisma.office.create({
      data: { name, address },
    });
    res.status(201).json(office);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create office' });
  }
});

router.put('/:id', authorize(['SUPER_ADMIN']), async (req, res) => {
  const id = req.params.id as string;
  const { name, address, isActive } = req.body;
  try {
    const office = await prisma.office.update({
      where: { id },
      data: { name, address, isActive },
    });
    res.json(office);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update office' });
  }
});

// Assign user to office
router.post('/:id/assign-user', authorize(['SUPER_ADMIN']), async (req, res) => {
  const id = req.params.id as string;
  const { userId } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { officeId: id },
      select: { id: true, username: true, firstName: true, lastName: true, role: true, officeId: true },
    });
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: 'Failed to assign user to office' });
  }
});

export default router;
