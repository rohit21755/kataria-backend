import { Router } from 'express';
import prisma from '../utils/db';
import { authenticateToken, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const { clientId, officeId, status, direction, method, startDate, endDate } = req.query;

    const where: Record<string, any> = {};
    if (clientId) where.clientId = clientId as string;
    if (officeId) where.officeId = officeId as string;
    if (status) where.status = status as string;
    if (direction) where.direction = direction as string;
    if (method) where.method = method as string;

    if (startDate || endDate) {
      const dateFilter: Record<string, Date> = {};
      if (startDate) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        dateFilter.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);
        dateFilter.lte = end;
      }
      where.createdAt = dateFilter;
    }

    const transactions = await prisma.transaction.findMany({
      where,
      include: {
        client: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        performedBy: { select: { id: true, firstName: true, lastName: true, role: true } },
        office: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.post('/', authorize(['SUPER_ADMIN', 'OFFICE_STAFF', 'FIELD_WORKER']), async (req, res) => {
  const {
    direction,
    method,
    amount,
    cashAmount,
    bankAmount,
    bankAccountNumber,
    bankName,
    bankReference,
    ifscCode,
    companyBankAccount,
    clientId,
    officeId,
    description,
    agentName,
    agentPhone,
    // performedById can be overridden (for office WebAuthn flow)
    // if not provided, defaults to the JWT user
    performedById: overridePerformerId,
  } = req.body;

  const jwtUserId = req.user!.userId;
  const jwtRole = req.user!.role;

  if (!direction || !method || !amount || !clientId) {
    return res.status(400).json({ error: 'direction, method, amount, and clientId are required' });
  }

  if (!['IN', 'OUT'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be IN or OUT' });
  }

  if (!['CASH', 'BANK', 'CASH_BANK'].includes(method)) {
    return res.status(400).json({ error: 'method must be CASH, BANK, or CASH_BANK' });
  }

  if ((method === 'BANK' || method === 'CASH_BANK') && (!bankAccountNumber || !bankName || !bankReference || !ifscCode || !companyBankAccount)) {
    return res.status(400).json({ error: 'bankAccountNumber, bankName, bankReference, ifscCode, and companyBankAccount are required for BANK/CASH_BANK' });
  }

  if (method === 'CASH_BANK') {
    if (!cashAmount || !bankAmount) {
      return res.status(400).json({ error: 'cashAmount and bankAmount required for CASH_BANK method' });
    }
    if (Math.abs((cashAmount + bankAmount) - amount) > 0.01) {
      return res.status(400).json({ error: 'cashAmount + bankAmount must equal amount' });
    }
  }

  // Determine the actual performer
  // Super Admin creates from super_admin app → performer = admin themselves, label = "Admin"
  // Office dashboard sends overridePerformerId (WebAuthn-identified user)
  // Mobile (FIELD_WORKER) → performer = JWT user, label = their full name
  let effectivePerformerId = jwtUserId;

  if (overridePerformerId && (jwtRole === 'SUPER_ADMIN' || jwtRole === 'OFFICE_STAFF')) {
    effectivePerformerId = overridePerformerId;
  }

  try {
    const [performerUser, clientProfile] = await Promise.all([
      prisma.user.findUnique({ where: { id: effectivePerformerId }, select: { firstName: true, lastName: true, role: true } }),
      prisma.clientProfile.findUnique({ where: { id: clientId }, select: { userId: true } }),
    ]);

    if (!performerUser) return res.status(404).json({ error: 'Performer user not found' });
    if (!clientProfile) return res.status(404).json({ error: 'Client not found' });

    // Build performedByLabel
    const performedByLabel =
      jwtRole === 'SUPER_ADMIN' && !overridePerformerId
        ? 'Admin'
        : `${performerUser.firstName} ${performerUser.lastName}`.trim();

    const result = await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          direction,
          method,
          amount: Number(amount),
          cashAmount: cashAmount ? Number(cashAmount) : null,
          bankAmount: bankAmount ? Number(bankAmount) : null,
          bankAccountNumber: bankAccountNumber || null,
          bankName: bankName || null,
          bankReference: bankReference || null,
          ifscCode: ifscCode || null,
          companyBankAccount: companyBankAccount || null,
          clientId,
          officeId: officeId || null,
          performedById: effectivePerformerId,
          performedByLabel,
          description: description || null,
          agentName: agentName || null,
          agentPhone: agentPhone || null,
          status: 'COMPLETED',
        },
        include: {
          client: { include: { user: { select: { firstName: true, lastName: true } } } },
          performedBy: { select: { firstName: true, lastName: true, role: true } },
        },
      });

      // Ledger entry for the client
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { userId: clientProfile.userId },
        orderBy: { createdAt: 'desc' },
      });
      const prevBalance = lastEntry?.balanceAfter ?? 0;
      const isCredit = direction === 'IN'; // money coming IN = credit for the office/system
      const newBalance = isCredit ? prevBalance + amount : prevBalance - amount;

      await tx.ledgerEntry.create({
        data: {
          userId: clientProfile.userId,
          transactionId: transaction.id,
          credit: isCredit ? Number(amount) : 0,
          debit: isCredit ? 0 : Number(amount),
          balanceAfter: newBalance,
        },
      });

      // Update DailyCash
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const dailyCashUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (method === 'CASH' || method === 'CASH_BANK') {
        const cAmt = method === 'CASH' ? Number(amount) : Number(cashAmount);
        if (direction === 'IN') dailyCashUpdate.cashIn = { increment: cAmt };
        else dailyCashUpdate.cashOut = { increment: cAmt };
      }
      if (method === 'BANK' || method === 'CASH_BANK') {
        const bAmt = method === 'BANK' ? Number(amount) : Number(bankAmount);
        if (direction === 'IN') dailyCashUpdate.bankIn = { increment: bAmt };
        else dailyCashUpdate.bankOut = { increment: bAmt };
      }

      // openingBalance is set to 0 for a new day per business requirement
      const openingBalance = 0;

      await tx.dailyCash.upsert({
        where: { date: today },
        create: {
          date: today,
          openingBalance,
          cashIn: (method === 'CASH' || method === 'CASH_BANK') && direction === 'IN'
            ? Number(method === 'CASH' ? amount : cashAmount) : 0,
          cashOut: (method === 'CASH' || method === 'CASH_BANK') && direction === 'OUT'
            ? Number(method === 'CASH' ? amount : cashAmount) : 0,
          bankIn: (method === 'BANK' || method === 'CASH_BANK') && direction === 'IN'
            ? Number(method === 'BANK' ? amount : bankAmount) : 0,
          bankOut: (method === 'BANK' || method === 'CASH_BANK') && direction === 'OUT'
            ? Number(method === 'BANK' ? amount : bankAmount) : 0,
          closingBalance: direction === 'IN' ? openingBalance + Number(amount) : openingBalance - Number(amount),
        },
        update: {
          ...(dailyCashUpdate as object),
          closingBalance: { increment: direction === 'IN' ? Number(amount) : -Number(amount) },
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'CREATE',
          entityType: 'TRANSACTION',
          entityId: transaction.id,
          performedBy: jwtUserId,
          details: { direction, method, amount, clientId, performedByLabel },
        },
      });

      return transaction;
    });

    res.status(201).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Transaction failed' });
  }
});

router.post('/:id/reverse', authorize(['SUPER_ADMIN']), async (req, res) => {
  const id = req.params.id as string;
  const performedById = req.user!.userId;

  try {
    const original = await prisma.transaction.findUnique({ where: { id } });
    if (!original) return res.status(404).json({ error: 'Transaction not found' });
    if (original.status === 'REVERSED') {
      return res.status(400).json({ error: 'Transaction already reversed' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.transaction.update({ where: { id }, data: { status: 'REVERSED' } });

      const clientProfile = await tx.clientProfile.findUnique({
        where: { id: original.clientId },
        select: { userId: true },
      });
      if (!clientProfile) throw new Error('Client not found');

      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { userId: clientProfile.userId },
        orderBy: { createdAt: 'desc' },
      });
      const prevBalance = lastEntry?.balanceAfter ?? 0;
      // Reversal flips direction
      const wasCredit = original.direction === 'IN';
      const reversalBalance = wasCredit
        ? prevBalance - original.amount
        : prevBalance + original.amount;

      await tx.ledgerEntry.create({
        data: {
          userId: clientProfile.userId,
          transactionId: id,
          credit: wasCredit ? 0 : original.amount,
          debit: wasCredit ? original.amount : 0,
          balanceAfter: reversalBalance,
        },
      });

      // Reverse DailyCash
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dailyCashReversal: Record<string, unknown> = {};
      if (original.method === 'CASH' || original.method === 'CASH_BANK') {
        const cAmt = original.method === 'CASH' ? original.amount : (original.cashAmount ?? 0);
        if (original.direction === 'IN') dailyCashReversal.cashIn = { decrement: cAmt };
        else dailyCashReversal.cashOut = { decrement: cAmt };
      }
      if (original.method === 'BANK' || original.method === 'CASH_BANK') {
        const bAmt = original.method === 'BANK' ? original.amount : (original.bankAmount ?? 0);
        if (original.direction === 'IN') dailyCashReversal.bankIn = { decrement: bAmt };
        else dailyCashReversal.bankOut = { decrement: bAmt };
      }

      await tx.dailyCash.updateMany({
        where: { date: today },
        data: {
          ...(dailyCashReversal as object),
          closingBalance: { increment: original.direction === 'IN' ? -original.amount : original.amount },
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'REVERSE',
          entityType: 'TRANSACTION',
          entityId: id,
          performedBy: performedById,
        },
      });

      return { id, status: 'REVERSED' };
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Reversal failed' });
  }
});

export default router;
