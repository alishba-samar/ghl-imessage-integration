import type {
  Capability,
  InboundMessage,
  SendMessageInput,
  SendMessageResult,
  StatusUpdate,
} from './types';

export interface IMessageProvider {
  readonly name: string;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  checkCapability(phone: string): Promise<Capability>;
  getMessageStatus(providerMessageId: string): Promise<StatusUpdate | null>;
  /** Returns null when the payload is not a recognizable inbound message. */
  parseInboundWebhook(body: unknown): InboundMessage | null;
  /** Returns null when the payload is not a recognizable status update. */
  parseStatusWebhook(body: unknown): StatusUpdate | null;
}
