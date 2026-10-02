export type MessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** Channel the message actually went over. */
export type DeliveryService = 'imessage' | 'sms' | 'rcs';

export interface SendMessageInput {
  to: string;
  from: string;
  content: string;
  mediaUrl?: string;
  statusCallbackUrl?: string;
}

export interface SendMessageResult {
  /** Absent when the send failed before the provider assigned an id. */
  providerMessageId?: string;
  status: MessageStatus;
  errorCode?: string;
  errorMessage?: string;
  service?: DeliveryService;
  /** True when the provider fell back from iMessage to SMS. */
  wasDowngraded?: boolean;
}

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  to: string;
  content: string;
  mediaUrl?: string;
  receivedAt: Date;
}

export interface StatusUpdate {
  providerMessageId: string;
  status: Exclude<MessageStatus, 'QUEUED'>;
  errorCode?: string;
  errorMessage?: string;
  isPermanentFailure?: boolean;
  service?: DeliveryService;
  /** True when the provider fell back from iMessage to SMS. */
  wasDowngraded?: boolean;
}

export type Capability = 'available' | 'unavailable' | 'unknown';
