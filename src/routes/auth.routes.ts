import { Router } from 'express';
import { login, register, registerDeviceFingerprint, verifyDeviceFingerprint } from '../controllers/auth.controller';
import { 
  generateRegOptions, 
  verifyReg, 
  generateAuthOptions, 
  verifyAuth 
} from '../controllers/webauthn.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/register', register); // Setup an initial user or allow admins to create

// Device Fingerprint Registration and Verification
router.post('/device-fingerprint/register', authenticateToken, registerDeviceFingerprint);
router.post('/device-fingerprint/verify', verifyDeviceFingerprint);

// Physical Hardware Biometric WebAuthn (Touch ID / Windows Hello)
router.get('/webauthn/register/options', authenticateToken, generateRegOptions);
router.post('/webauthn/register/verify', authenticateToken, verifyReg);
router.post('/webauthn/verify/options', generateAuthOptions);
router.post('/webauthn/verify/verify', verifyAuth);

export default router;
