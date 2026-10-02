import { Router } from 'express';
import { requireApiKey } from '../middleware/requireApiKey';
import { sendIMessage } from '../services/sendService';

export const imessageRouter = Router();

imessageRouter.use(requireApiKey);

imessageRouter.post('/send', async (req, res) => {
  const result = await sendIMessage(req.body);

  if (!result.ok) {
    const status = result.error === 'SUPPRESSED' ? 409 : 400;
    res.status(status).json({ error: result.error, details: result.details });
    return;
  }

  if (result.duplicate) res.setHeader('Idempotent-Replayed', 'true');
  res.json(result.message);
});
