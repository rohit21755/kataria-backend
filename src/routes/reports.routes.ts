import { Router } from 'express';
import prisma from '../utils/db';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticateToken);

// ─── Date helpers ───────────────────────────────────────────

function periodRange(period: string, startDate?: string, endDate?: string): { start: Date; end: Date } {
  if (startDate || endDate) {
    const start = startDate ? new Date(startDate) : new Date(0);
    if (startDate) start.setHours(0, 0, 0, 0);
    
    const end = endDate ? new Date(endDate) : new Date();
    if (endDate) end.setHours(23, 59, 59, 999);
    
    return { start, end };
  }

  const now = new Date();
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  if (period === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }
  if (period === 'week') {
    const start = new Date();
    const day = start.getDay();
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }
  // 'all' — use epoch
  return { start: new Date(0), end };
}

// ─── Dashboard Summary ──────────────────────────────────────

router.get('/dashboard-summary', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let dailyCash = await prisma.dailyCash.findFirst({ where: { date: today } });
    if (!dailyCash) {
      const lastRecord = await prisma.dailyCash.findFirst({
        where: { date: { lt: today } },
        orderBy: { date: 'desc' },
      });
      if (lastRecord) {
        dailyCash = {
          id: '',
          date: today,
          openingBalance: lastRecord.closingBalance,
          cashIn: 0,
          cashOut: 0,
          bankIn: 0,
          bankOut: 0,
          closingBalance: lastRecord.closingBalance,
          updatedAt: new Date(),
        };
      }
    }

    const txnCount = await prisma.transaction.count({ where: { status: 'COMPLETED' } });

    res.json({
      dailyCash: dailyCash ?? { openingBalance: 0, cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, closingBalance: 0 },
      txnCount,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// ─── Balance by Period (Super Admin) ───────────────────────
// GET /reports/balance?period=today|week|month|all
// Returns opening, closing, totalIn, totalOut for the system

router.get('/balance', async (req, res) => {
  const period = (req.query.period as string) || 'today';
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  const { start, end } = periodRange(period, startDate, endDate);

  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
      },
      select: { direction: true, amount: true, method: true, cashAmount: true, bankAmount: true },
    });

    let totalIn = 0, totalOut = 0, cashIn = 0, cashOut = 0, bankIn = 0, bankOut = 0;

    for (const t of transactions) {
      const cash =
        t.method === 'CASH' ? t.amount :
        t.method === 'CASH_BANK' ? (t.cashAmount ?? 0) : 0;
      const bank =
        t.method === 'BANK' ? t.amount :
        t.method === 'CASH_BANK' ? (t.bankAmount ?? 0) : 0;

      if (t.direction === 'IN') {
        totalIn += t.amount;
        cashIn += cash;
        bankIn += bank;
      } else {
        totalOut += t.amount;
        cashOut += cash;
        bankOut += bank;
      }
    }

    let openingBalance = 0;
    const dailyCash = await prisma.dailyCash.findUnique({ where: { date: start } });
    if (dailyCash) {
      openingBalance = dailyCash.openingBalance;
    } else {
      const prevDaily = await prisma.dailyCash.findFirst({
        where: { date: { lt: start } },
        orderBy: { date: 'desc' },
      });
      if (prevDaily) {
        openingBalance = prevDaily.closingBalance;
      } else {
        const prevTxns = await prisma.transaction.findMany({
          where: { status: 'COMPLETED', createdAt: { lt: start } },
          select: { direction: true, amount: true },
        });
        for (const t of prevTxns) {
          openingBalance += t.direction === 'IN' ? t.amount : -t.amount;
        }
      }
    }

    const closingBalance = openingBalance + totalIn - totalOut;

    res.json({ period, openingBalance, closingBalance, totalIn, totalOut, cashIn, cashOut, bankIn, bankOut });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// ─── Office Balance ─────────────────────────────────────────
// GET /reports/office-balance/:officeId?period=today|week|month|all

router.get('/office-balance/:officeId', async (req, res) => {
  const { officeId } = req.params;
  const period = (req.query.period as string) || 'today';
  const { start, end } = periodRange(period);

  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        officeId,
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
      },
      select: { direction: true, amount: true },
    });

    let totalIn = 0, totalOut = 0;
    for (const t of transactions) {
      if (t.direction === 'IN') totalIn += t.amount;
      else totalOut += t.amount;
    }

    const prevTxns = await prisma.transaction.findMany({
      where: { officeId, status: 'COMPLETED', createdAt: { lt: start } },
      select: { direction: true, amount: true },
    });
    let openingBalance = 0;
    for (const t of prevTxns) {
      openingBalance += t.direction === 'IN' ? t.amount : -t.amount;
    }

    res.json({ officeId, period, openingBalance, closingBalance: openingBalance + totalIn - totalOut, totalIn, totalOut });
  } catch {
    res.status(500).json({ error: 'Failed to fetch office balance' });
  }
});

// ─── User Balance ───────────────────────────────────────────
// GET /reports/user-balance/:userId?period=today|week|month|all

router.get('/user-balance/:userId', async (req, res) => {
  const { userId } = req.params;
  const period = (req.query.period as string) || 'all';
  const { start, end } = periodRange(period);

  try {
    // Transactions PERFORMED by this user
    const transactions = await prisma.transaction.findMany({
      where: {
        performedById: userId,
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
      },
      select: { direction: true, amount: true },
    });

    let totalIn = 0, totalOut = 0;
    for (const t of transactions) {
      if (t.direction === 'IN') totalIn += t.amount;
      else totalOut += t.amount;
    }

    // Clients created by this user in the period
    const clientsCreated = await prisma.clientProfile.count({
      where: { createdById: userId, createdAt: { gte: start, lte: end } },
    });

    // Ledger-based balance (most recent entry)
    const latestLedger = await prisma.ledgerEntry.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    // Opening ledger balance at start of period
    const entryBeforePeriod = await prisma.ledgerEntry.findFirst({
      where: { userId, createdAt: { lt: start } },
      orderBy: { createdAt: 'desc' },
    });
    const openingBalance = entryBeforePeriod?.balanceAfter ?? 0;

    res.json({
      userId,
      period,
      openingBalance,
      closingBalance: latestLedger?.balanceAfter ?? 0,
      totalIn,
      totalOut,
      clientsCreated,
      txnCount: transactions.length,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch user balance' });
  }
});

// ─── Ledger ─────────────────────────────────────────────────

router.get('/ledger/:userId', async (req, res) => {
  const { userId } = req.params;
  const jwtUserId = req.user!.userId;
  const jwtRole = req.user!.role;

  try {
    // If the user is a field worker and requesting someone else's ledger, ensure they created that client
    if (jwtRole === 'FIELD_WORKER' && userId !== jwtUserId) {
      const clientProfile = await prisma.clientProfile.findFirst({
        where: {
          userId,
          createdById: jwtUserId,
        },
      });
      if (!clientProfile) {
        return res.status(403).json({ error: "Forbidden: You are only allowed to view your own ledger and your clients' ledger." });
      }
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: { userId },
      include: {
        transaction: {
          select: {
            direction: true, method: true, amount: true, performedByLabel: true, description: true,
            client: { include: { user: { select: { firstName: true, lastName: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(entries);
  } catch {
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// ─── Daily Cash ──────────────────────────────────────────────

router.get('/daily-cash', async (req, res) => {
  try {
    const records = await prisma.dailyCash.findMany({
      orderBy: { date: 'desc' },
      take: 60,
    });
    res.json(records);
  } catch {
    res.status(500).json({ error: 'Failed to fetch daily cash records' });
  }
});

router.put('/daily-cash/:date', async (req, res) => {
  const { date } = req.params;
  const { openingBalance, closingBalance } = req.body;
  try {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);

    let existing = await prisma.dailyCash.findUnique({ where: { date: d } });
    if (!existing) {
      const prev = await prisma.dailyCash.findFirst({
        where: { date: { lt: d } },
        orderBy: { date: 'desc' },
      });
      existing = await prisma.dailyCash.create({
        data: {
          date: d,
          openingBalance: prev?.closingBalance ?? 0,
          closingBalance: prev?.closingBalance ?? 0,
        },
      });
    }

    const endOfDay = new Date(d);
    endOfDay.setHours(23, 59, 59, 999);

    const txns = await prisma.transaction.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: { gte: d, lte: endOfDay },
      },
      select: { direction: true, amount: true },
    });

    let netTxnAmount = 0;
    for (const t of txns) {
      netTxnAmount += t.direction === 'IN' ? t.amount : -t.amount;
    }

    const newOpening = openingBalance !== undefined ? Number(openingBalance) : existing.openingBalance;
    const newClosing = closingBalance !== undefined ? Number(closingBalance) : newOpening + netTxnAmount;

    const updated = await prisma.dailyCash.update({
      where: { date: d },
      data: {
        openingBalance: newOpening,
        closingBalance: newClosing,
      },
    });

    res.json(updated);
  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Failed to update daily cash' });
  }
});

router.delete('/daily-cash/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await prisma.dailyCash.delete({
      where: { id },
    });
    res.json(deleted);
  } catch (err) {
    res.status(400).json({ error: 'Failed to delete daily cash record' });
  }
});

router.post('/daily-cash/settle', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let todayRecord = await prisma.dailyCash.findUnique({ where: { date: today } });
    
    if (!todayRecord) {
      const lastRecord = await prisma.dailyCash.findFirst({
        where: { date: { lt: today } },
        orderBy: { date: 'desc' },
      });
      todayRecord = await prisma.dailyCash.create({
        data: {
          date: today,
          openingBalance: lastRecord?.closingBalance || 0,
          closingBalance: lastRecord?.closingBalance || 0,
        }
      });
    }

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const tomorrowRecord = await prisma.dailyCash.upsert({
      where: { date: tomorrow },
      update: { openingBalance: todayRecord.closingBalance },
      create: {
        date: tomorrow,
        openingBalance: todayRecord.closingBalance,
        closingBalance: todayRecord.closingBalance,
      }
    });

    res.json({ message: 'Settlement completed', tomorrowRecord });
  } catch (err) {
    res.status(500).json({ error: 'Failed to settle daily cash' });
  }
});

export default router;
