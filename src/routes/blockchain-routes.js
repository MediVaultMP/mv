import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../utils/async-handler.js';

const simulateBody = z.object({
  kind: z.enum(['basic_profile', 'prescription']),
  resourceId: z.string().uuid().optional(),
  changes: z.record(z.string(), z.string().max(200))
}).strict();

// The patient's own on-chain ledger and the read-only "what if it was edited" check.
export function createPatientBlockchainRouter(authService, blockchainLedgerService) {
  const router = Router();

  const patientOnly = [authenticate(authService), authorize('patient')];

  router.get('/me/blockchain', ...patientOnly, asyncHandler(async (req, res) => {
    res.json(await blockchainLedgerService.getPatientLedger(req.user.sub));
  }));

  router.post('/me/blockchain/simulate', ...patientOnly, asyncHandler(async (req, res) => {
    const body = simulateBody.parse(req.body);
    res.json(await blockchainLedgerService.simulateEdit(req.user.sub, body));
  }));

  return router;
}

// Public: tells the login page whether demo sign-in buttons should show.
export function createDemoRouter(demoService) {
  const router = Router();

  router.get('/accounts', (req, res) => {
    res.json(demoService.publicAccounts());
  });

  return router;
}
