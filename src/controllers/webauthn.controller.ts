import { Request, Response } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import prisma from '../utils/db';

const RP_ID = 'localhost';
const RP_NAME = 'KATARIA EMPIRE LLP';
const EXPECTED_ORIGIN = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'];

// Simple in-memory cache to store challenges temporarily
const challengeCache = new Map<string, { challenge: string; userId: string }>();

// ─── WebAuthn Registration Options ──────────────────────────────────────────

export const generateRegOptions = async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ message: 'userId query parameter is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { biometricFingerprints: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Exclude already registered credentials to avoid duplicates
    const excludeCredentials = user.biometricFingerprints.map((cred) => ({
      id: cred.credentialId,
      type: 'public-key' as const,
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(user.id),
      userName: user.username,
      userDisplayName: `${user.firstName} ${user.lastName}`.trim(),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // Enforce local hardware (Touch ID/Windows Hello)
        residentKey: 'discouraged',          // Bypasses permanent Passkey vault storing
        requireResidentKey: false,
        userVerification: 'required',        // FORCE Touch ID biometric scanner prompt
      },
    });

    // Store the challenge for verification step
    challengeCache.set(user.id, {
      challenge: options.challenge,
      userId: user.id,
    });

    res.json(options);
  } catch (error: any) {
    console.error('Error generating registration options:', error);
    res.status(500).json({ message: 'Failed to generate registration options', error: error.message });
  }
};

// ─── WebAuthn Registration Verification ──────────────────────────────────────

export const verifyReg = async (req: Request, res: Response) => {
  try {
    const { userId, ...body } = req.body;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ message: 'userId is required' });
    }

    const storedChallenge = challengeCache.get(userId);
    if (!storedChallenge) {
      return res.status(400).json({ message: 'Registration challenge not found or expired. Please retry.' });
    }

    challengeCache.delete(userId);

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    const { verified, registrationInfo } = verification;

    if (!verified || !registrationInfo) {
      return res.status(400).json({ message: 'Biometric verification failed' });
    }

    const { credential } = registrationInfo;
    const { id: credentialID, publicKey: credentialPublicKey, counter } = credential;

    // Save registration credentials to database
    await prisma.biometricFingerprint.create({
      data: {
        userId,
        credentialId: credentialID,
        publicKey: Buffer.from(credentialPublicKey).toString('base64url'),
        counter,
        transports: body.response.transports || [],
      },
    });

    // Mark user clientProfile as verified if client
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { clientProfile: true },
    });

    if (user && user.role === 'CLIENT' && user.clientProfile) {
      await prisma.clientProfile.update({
        where: { userId },
        data: { fingerprintVerified: true },
      });
    }

    res.json({ verified: true, message: 'Fingerprint registered successfully' });
  } catch (error: any) {
    console.error('Error verifying registration:', error);
    res.status(500).json({ message: 'Failed to verify registration', error: error.message });
  }
};

// ─── WebAuthn Authentication Options ────────────────────────────────────────

export const generateAuthOptions = async (req: Request, res: Response) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ message: 'Username is required' });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: { biometricFingerprints: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.biometricFingerprints.length === 0) {
      return res.status(400).json({ message: 'No biometric credentials registered for this user.' });
    }

    // Direct mapping to enforce Touch ID bypass dialogue:
    // When we feed the explicit IDs, Chrome skips passkey lookups and scans immediately!
    const allowCredentials = user.biometricFingerprints.map((cred) => ({
      id: cred.credentialId,
      type: 'public-key' as const,
      transports: cred.transports as any,
    }));

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: 'required', // FORCE Touch ID biometric prompt
    });

    challengeCache.set(user.id, {
      challenge: options.challenge,
      userId: user.id,
    });

    res.json({
      options,
      userId: user.id,
      userInfo: {
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (error: any) {
    console.error('Error generating authentication options:', error);
    res.status(500).json({ message: 'Failed to generate authentication options', error: error.message });
  }
};

// ─── WebAuthn Authentication Verification ───────────────────────────────────

export const verifyAuth = async (req: Request, res: Response) => {
  try {
    const { userId, response } = req.body;
    if (!userId || !response) {
      return res.status(400).json({ message: 'userId and response are required' });
    }

    const storedChallenge = challengeCache.get(userId);
    if (!storedChallenge) {
      return res.status(400).json({ message: 'Authentication challenge not found or expired. Please retry.' });
    }

    challengeCache.delete(userId);

    const credentialIdB64url = response.id;
    const dbCred = await prisma.biometricFingerprint.findUnique({
      where: { credentialId: credentialIdB64url },
    });

    if (!dbCred || dbCred.userId !== userId) {
      return res.status(400).json({ message: 'Biometric credential not recognized' });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: dbCred.credentialId,
        publicKey: new Uint8Array(Buffer.from(dbCred.publicKey, 'base64url')),
        counter: dbCred.counter,
        transports: dbCred.transports as any,
      },
    });

    const { verified, authenticationInfo } = verification;

    if (!verified || !authenticationInfo) {
      return res.status(400).json({ verified: false, message: 'Fingerprint signature mismatch' });
    }

    // Update sign counter to prevent replay
    await prisma.biometricFingerprint.update({
      where: { id: dbCred.id },
      data: { counter: authenticationInfo.newCounter },
    });

    res.json({ verified: true });
  } catch (error: any) {
    console.error('Error verifying authentication:', error);
    res.status(500).json({ message: 'Failed to verify fingerprint signature', error: error.message });
  }
};
