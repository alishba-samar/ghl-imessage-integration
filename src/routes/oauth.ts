import { Router, type Response } from 'express';
import { env } from '../config/env';
import { connectAgencyLocations, saveCompanyTokens } from '../ghl/agency';
import { saveTokens } from '../ghl/ghlClient';
import { GhlError } from '../ghl/http';
import { exchangeCode } from '../ghl/oauth';
import { logger } from '../utils/logger';

export const oauthRouter = Router();

/** GHL redirects here after a location installs the app: /oauth/callback?code=... */
oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  if (!code) {
    sendPage(res, 400, 'Installation failed', 'The authorization code is missing. Please try installing the app again.');
    return;
  }

  try {
    const tokens = await exchangeCode(code);

    // Agency user installed the app: GHL returns a Company token. Store it and connect each installed location.
    if (tokens.userType === 'Company' && tokens.companyId) {
      await saveCompanyTokens(tokens.companyId, tokens);
      logger.info({ companyId: tokens.companyId, expiresAt: tokens.expiresAt }, 'GHL agency token saved');
      const result = await connectAgencyLocations(tokens.companyId);
      const names = result.connected.map((l) => l.name ?? l.locationId);
      if (result.connected.length === 0) {
        sendPage(
          res,
          result.failed.length > 0 ? 502 : 200,
          result.failed.length > 0 ? 'Installation incomplete' : 'App installed for the agency',
          result.failed.length > 0
            ? 'The app was installed, but no sub-account could be connected. Please try again or contact support.'
            : 'The app is installed at the agency level, but no sub-accounts were selected. Install it on a sub-account to start messaging.',
        );
        return;
      }
      sendPage(
        res,
        200,
        'App installed',
        `The iMessage integration is connected for: ${names.join(', ')}.` +
          (result.failed.length > 0 ? ` ${result.failed.length} sub-account(s) could not be connected.` : '') +
          ' You can close this window.',
      );
      return;
    }

    if (tokens.userType !== 'Location' || !tokens.locationId) {
      logger.warn({ userType: tokens.userType, companyId: tokens.companyId }, 'OAuth callback returned an unexpected token type');
      sendPage(res, 400, 'Installation not supported', 'Please install the app on a sub-account (location) or from the agency.');
      return;
    }

    // The provider id lets inbound replies reach GHL Conversations; without it they're only stored locally.
    await saveTokens(tokens.locationId, tokens, { conversationProviderId: env.GHL_CONVERSATION_PROVIDER_ID });
    if (!env.GHL_CONVERSATION_PROVIDER_ID) {
      logger.warn({ locationId: tokens.locationId }, 'GHL_CONVERSATION_PROVIDER_ID not set; inbound replies will not sync to GHL');
    }
    logger.info({ locationId: tokens.locationId, companyId: tokens.companyId, expiresAt: tokens.expiresAt }, 'GHL app installed');
    sendPage(res, 200, 'App installed', 'The iMessage integration is connected. You can close this window.');
  } catch (err) {
    if (err instanceof GhlError) {
      logger.error({ code: err.code, ...err.details }, 'OAuth callback failed');
      const status = err.code === 'NOT_CONFIGURED' ? 500 : 502;
      sendPage(res, status, 'Installation failed', 'We could not complete the installation. Please try again.');
      return;
    }
    logger.error({ err }, 'OAuth callback failed');
    sendPage(res, 500, 'Installation failed', 'We could not complete the installation. Please try again.');
  }
});

function sendPage(res: Response, status: number, title: string, message: string): void {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escapeHtml(title)}</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.5rem}</style>` +
        `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
