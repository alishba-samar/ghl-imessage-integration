import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/requireApiKey';
import { sendViaGhlWorkflow } from '../services/workflowSendService';

export const ghlWorkflowRouter = Router();

ghlWorkflowRouter.use(requireApiKey);

// GHL merge fields arrive as strings, and unset ones as "" (e.g. "{{contact.phone}}" for a contact
// without a phone), so blanks are treated as missing and campaignStep is coerced from text.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const workflowSendSchema = z.object({
  locationId: z.preprocess(blankToUndefined, z.string().trim().min(1)),
  contactId: z.preprocess(blankToUndefined, z.string().trim().min(1)),
  phone: z.preprocess(blankToUndefined, z.string().trim().min(1)),
  message: z.preprocess(blankToUndefined, z.string().min(1)),
  campaignId: z.preprocess(blankToUndefined, z.string().trim().min(1).optional()),
  campaignStep: z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().optional()),
});

/**
 * Called by a GHL workflow "Custom Webhook" action (Event: CUSTOM, POST, JSON body), e.g.:
 *   { "locationId": "{{location.id}}", "contactId": "{{contact.id}}", "phone": "{{contact.phone}}",
 *     "message": "...", "campaignId": "spring-promo", "campaignStep": "1" }
 * The message is sent through GHL (so it appears in GHL Conversations) and delivered by our Delivery URL;
 * see workflowSendService. Returns 200 for every processed request (accepted, duplicate step, suppressed,
 * not connected, GHL send failure) so the workflow doesn't retry needlessly; 400 only for invalid input
 * (including an unparseable phone), 401 (requireApiKey) only for a bad key.
 */
ghlWorkflowRouter.post('/send-imessage', async (req, res) => {
  const parsed = workflowSendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'VALIDATION_ERROR', details: z.prettifyError(parsed.error) });
    return;
  }

  const result = await sendViaGhlWorkflow(parsed.data);

  if (!result.ok) {
    res.status(result.error === 'INVALID_PHONE' ? 400 : 200).json({
      ok: false,
      error: result.error,
      details: result.details,
      ...('message' in result && { messageId: result.message.id }),
    });
    return;
  }

  // status is usually QUEUED here: the provider send happens when GHL calls our Delivery URL.
  res.status(200).json({
    ok: result.message.status !== 'FAILED',
    status: result.message.status,
    messageId: result.message.id,
    ghlMessageId: result.message.ghlMessageId,
    duplicate: result.duplicate,
    ...(result.message.status === 'FAILED' && { errorCode: result.message.errorCode, errorMessage: result.message.errorMessage }),
  });
});
