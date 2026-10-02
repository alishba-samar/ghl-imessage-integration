import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../utils/logger';
import type { IMessageProvider } from './IMessageProvider';
import type {
  Capability,
  InboundMessage,
  SendMessageInput,
  SendMessageResult,
  StatusUpdate,
} from './types';

// Payload shapes the mock accepts on its webhooks, for local testing:
//   inbound: { "id": "mock_in_1", "from": "+14155550101", "to": "+15550001111", "content": "Thanks!" }
//   status:  { "id": "mock_<uuid>", "status": "DELIVERED", "service": "imessage" }
// Any other status value (e.g. "QUEUED") parses to null, like a provider's in-progress status.
const inboundSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  content: z.string(),
  mediaUrl: z.string().optional(),
  receivedAt: z.coerce.date().optional(),
});

const statusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  isPermanentFailure: z.boolean().optional(),
  service: z.enum(['imessage', 'sms', 'rcs']).optional(),
  wasDowngraded: z.boolean().optional(),
});

export class MockProvider implements IMessageProvider {
  readonly name = 'mock';

  // In-memory only; lets getMessageStatus return something for messages sent this process.
  private readonly sent = new Map<string, StatusUpdate>();

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const providerMessageId = `mock_${randomUUID()}`;

    const result: SendMessageResult = input.content.includes('FAIL')
      ? {
          providerMessageId,
          status: 'FAILED',
          errorCode: 'MOCK_FAILURE',
          errorMessage: 'Simulated failure (content contained "FAIL")',
        }
      : { providerMessageId, status: 'SENT', service: 'imessage', wasDowngraded: false };

    this.sent.set(providerMessageId, {
      providerMessageId,
      status: result.status === 'FAILED' ? 'FAILED' : 'SENT',
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      isPermanentFailure: result.status === 'FAILED' ? true : undefined,
      service: result.service,
      wasDowngraded: result.wasDowngraded,
    });

    logger.info({ provider: this.name, ...input, result }, 'Mock message sent');
    return result;
  }

  async checkCapability(_phone: string): Promise<Capability> {
    return 'available';
  }

  async getMessageStatus(providerMessageId: string): Promise<StatusUpdate | null> {
    return this.sent.get(providerMessageId) ?? null;
  }

  parseInboundWebhook(body: unknown): InboundMessage | null {
    const parsed = inboundSchema.safeParse(body);
    if (!parsed.success) return null;
    const { id, receivedAt, ...rest } = parsed.data;
    return { providerMessageId: id, receivedAt: receivedAt ?? new Date(), ...rest };
  }

  parseStatusWebhook(body: unknown): StatusUpdate | null {
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) return null;
    const { id, ...rest } = parsed.data;
    return { providerMessageId: id, ...rest };
  }
}
