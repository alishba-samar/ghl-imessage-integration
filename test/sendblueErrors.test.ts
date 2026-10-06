import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { SendblueProvider, extractSendblueError } from '../src/providers/SendblueProvider';
import { ghlServer } from './helpers/ghl';

describe('extractSendblueError', () => {
  it('uses the documented { error_code, message } shape', () => {
    expect(extractSendblueError({ status: 'ERROR', error_code: 4000, message: 'Invalid number' }, 400)).toMatchObject({
      code: '4000',
      message: 'Invalid number',
    });
  });

  it('keeps the message when the code is a number (a string-only schema used to drop everything)', () => {
    expect(extractSendblueError({ status: 'ERROR', code: 400, message: 'Recipient not verified (sandbox)' }, 400)).toMatchObject({
      code: '400',
      message: 'Recipient not verified (sandbox)',
    });
  });

  it('prefers error_key as the code and reads a string or nested "error"', () => {
    expect(extractSendblueError({ error_key: 'CONTACT_NOT_VERIFIED', error: 'Recipient not verified (sandbox)' }, 400)).toMatchObject({
      code: 'CONTACT_NOT_VERIFIED',
      message: 'Recipient not verified (sandbox)',
    });
    expect(extractSendblueError({ error: { code: 'NOT_VERIFIED', message: 'Contact must text your number first' } }, 400)).toMatchObject({
      code: 'NOT_VERIFIED',
      message: 'Contact must text your number first',
    });
  });

  it('reads details.message, and lists details keys without their contents', () => {
    const err = extractSendblueError(
      { status: 'ERROR', details: { message: 'Recipient not verified', verify_contact_curl: 'curl -H "sb-api-key-id: $KEY" ...' } },
      400,
    );
    expect(err.message).toBe('Recipient not verified');
    expect(err.fields).toEqual({ status: 'ERROR', detailsKeys: ['message', 'verify_contact_curl'] });
    // The key name is listed, but the recovery command itself (which references API keys) is not.
    expect(JSON.stringify(err.fields)).not.toContain('sb-api-key-id');
  });

  it('falls back to the HTTP status when Sendblue gives no usable text', () => {
    expect(extractSendblueError({ status: 'ERROR' }, 400)).toMatchObject({ code: 'HTTP_400', message: 'Sendblue returned HTTP 400' });
    expect(extractSendblueError(null, 502)).toMatchObject({ code: 'HTTP_502', message: 'Sendblue returned HTTP 502' });
    expect(extractSendblueError('<html>Bad Gateway</html>', 502).code).toBe('HTTP_502');
  });
});

describe('SendblueProvider.sendMessage on a Sendblue error', () => {
  const provider = new SendblueProvider({ baseUrl: 'https://api.sendblue.test', apiKey: 'k', apiSecret: 's', fromNumber: '+15550001111' });

  it("returns FAILED with Sendblue's own code and message instead of just the HTTP status", async () => {
    ghlServer.use(
      http.post('https://api.sendblue.test/api/send-message', () =>
        HttpResponse.json({ status: 'ERROR', code: 400, error_key: 'CONTACT_NOT_VERIFIED', message: 'Recipient not verified (sandbox)' }, { status: 400 }),
      ),
    );

    const result = await provider.sendMessage({ to: '+923001234567', from: '', content: 'Hi' });

    expect(result).toEqual({ status: 'FAILED', errorCode: 'CONTACT_NOT_VERIFIED', errorMessage: 'Recipient not verified (sandbox)' });
  });

  it('still reports the HTTP status when the error body has no message', async () => {
    ghlServer.use(http.post('https://api.sendblue.test/api/send-message', () => HttpResponse.json({}, { status: 400 })));

    const result = await provider.sendMessage({ to: '+923001234567', from: '', content: 'Hi' });

    expect(result).toEqual({ status: 'FAILED', errorCode: 'HTTP_400', errorMessage: 'Sendblue returned HTTP 400' });
  });
});
