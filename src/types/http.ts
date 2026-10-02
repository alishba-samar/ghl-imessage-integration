import type { Request } from 'express';

/** Request with the raw JSON body bytes captured by express.json({ verify }) in app.ts. */
export type RawBodyRequest = Request & { rawBody?: Buffer };
