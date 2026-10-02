import { env } from '../config/env';
import type { IMessageProvider } from './IMessageProvider';
import { MockProvider } from './MockProvider';
import { SendblueProvider } from './SendblueProvider';

export type { IMessageProvider } from './IMessageProvider';
export * from './types';

let instance: IMessageProvider | undefined;

function createProvider(): IMessageProvider {
  switch (env.IMESSAGE_PROVIDER) {
    case 'mock':
      return new MockProvider();
    case 'sendblue': {
      const { SENDBLUE_API_KEY, SENDBLUE_API_SECRET, SENDBLUE_FROM_NUMBER } = env;
      // Already enforced by env validation; re-checked here to narrow the types.
      if (!SENDBLUE_API_KEY || !SENDBLUE_API_SECRET || !SENDBLUE_FROM_NUMBER) {
        throw new Error('Sendblue credentials are missing');
      }
      return new SendblueProvider({
        baseUrl: env.SENDBLUE_BASE_URL,
        apiKey: SENDBLUE_API_KEY,
        apiSecret: SENDBLUE_API_SECRET,
        fromNumber: SENDBLUE_FROM_NUMBER,
      });
    }
  }
}

export function getProvider(): IMessageProvider {
  instance ??= createProvider();
  return instance;
}
