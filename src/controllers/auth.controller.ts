import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../utils/db';

function signToken(userId: string, role: string): string {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' },
  );
}

// ─── Password Login ──────────────────────────────────────────

export const login = async (req: Request, res: Response) => {
  try {
    const { username, password, visitorId } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password required' });
    }

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid credentials or access denied' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Handle Fingerprint.com visitorId
    if (visitorId) {
      const existingFingerprint = await prisma.deviceFingerprint.findUnique({
        where: { visitorId },
      });

      if (!existingFingerprint) {
        await prisma.deviceFingerprint.create({
          data: {
            userId: user.id,
            visitorId,
          },
        });
      } else if (existingFingerprint.userId !== user.id) {
        console.log(`VisitorId ${visitorId} already associated with another user ${existingFingerprint.userId}`);
      }
    }

    const token = signToken(user.id, user.role);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        officeId: user.officeId,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const register = async (req: Request, res: Response) => {
  try {
    const { username, password, role, firstName, lastName, phone } = req.body;
    if (!username || !password || !role || !firstName) {
      return res.status(400).json({ message: 'username, password, role, firstName required' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, passwordHash, role, firstName, lastName: lastName || '', phone },
    });
    res.status(201).json({ message: 'User created', userId: user.id });
  } catch (error) {
    res.status(400).json({ message: 'Username already exists or invalid data' });
  }
};

// ─── Manual Device Fingerprint Registration ──────────────────

export const registerDeviceFingerprint = async (req: Request, res: Response) => {
  const currentUser = req.user;
  if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

  const { userId, visitorId } = req.body;
  if (!userId || !visitorId) {
    return res.status(400).json({ message: 'userId and visitorId are required' });
  }

  // Only SUPER_ADMIN or OFFICE_STAFF can register fingerprints for other users
  if (userId !== currentUser.userId && currentUser.role !== 'SUPER_ADMIN' && currentUser.role !== 'OFFICE_STAFF') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const existingFingerprint = await prisma.deviceFingerprint.findUnique({
      where: { visitorId },
    });

    if (existingFingerprint) {
      if (existingFingerprint.userId === userId) {
        return res.json({ message: 'Device already registered for this user', visitorId });
      } else {
        // Transfer fingerprint or error out. Let's transfer it to the new user.
        await prisma.deviceFingerprint.update({
          where: { visitorId },
          data: { userId },
        });
        return res.json({ message: 'Device transferred and registered successfully', visitorId });
      }
    }

    await prisma.deviceFingerprint.create({
      data: {
        userId,
        visitorId,
      },
    });

    // Also update fingerprintVerified to true for clients
    if (user.role === 'CLIENT') {
      await prisma.clientProfile.update({
        where: { userId },
        data: { fingerprintVerified: true },
      });
    }

    res.status(201).json({ message: 'Device registered successfully', visitorId });
  } catch (error) {
    console.error('Device Registration Error:', error);
    res.status(500).json({ message: 'Server error registering device fingerprint' });
  }
};

export const verifyDeviceFingerprint = async (req: Request, res: Response) => {
  const { username, visitorId } = req.body;
  if (!username || !visitorId) {
    return res.status(400).json({ message: 'username and visitorId are required' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { username },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const device = await prisma.deviceFingerprint.findFirst({
      where: {
        userId: user.id,
        visitorId,
      },
    });

    if (!device) {
      return res.status(400).json({ verified: false, message: 'Fingerprint does not match this user' });
    }

    res.json({
      verified: true,
      userId: user.id,
      userInfo: {
        firstName: user.firstName,
        lastName: user.lastName,
      }
    });
  } catch (error) {
    console.error('Device Verification Error:', error);
    res.status(500).json({ message: 'Server error verifying device fingerprint' });
  }
};
