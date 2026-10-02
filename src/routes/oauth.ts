import { Router, type Response } from 'express';
import { env } from '../config/env';
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

    // We request Location tokens; an agency (Company) token has no locationId and isn't supported yet.
    if (tokens.userType !== 'Location' || !tokens.locationId) {
      logger.warn({ userType: tokens.userType, companyId: tokens.companyId }, 'OAuth callback returned a non-Location token');
      sendPage(res, 400, 'Installation not supported', 'Please install the app on a sub-account (location), not at the agency level.');
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
