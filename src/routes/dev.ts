import { Router } from 'express';
import { z } from 'zod';
import { getProvider } from '../providers';
import { normalizeToE164 } from '../utils/phone';

// Temporary routes for local testing. Only mounted outside production.
export const devRouter = Router();

const testSendSchema = z.object({
  to: z.string().min(1),
  content: z.string().min(1),
  from: z.string().optional(),
});

devRouter.post('/test-send', async (req, res, next) => {
  try {
    const parsed = testSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }

    const to = normalizeToE164(parsed.data.to);
    if (!to) {
      res.status(400).json({ error: `Invalid phone number: ${parsed.data.to}` });
      return;
    }

    const result = await getProvider().sendMessage({
      to,
      // Empty → provider's default sender (SENDBLUE_FROM_NUMBER for Sendblue).
      from: parsed.data.from ?? '',
      content: parsed.data.content,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
