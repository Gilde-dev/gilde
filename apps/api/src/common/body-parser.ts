import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { IncomingMessage } from 'node:http';

export const DEFAULT_COPILOT_MAX_BODY = '10mb';

/** Keeps the exact bytes received; the GitHub webhook signature is computed over them. */
function keepRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
}

/**
 * Registers the body parsers. Use it with `bodyParser: false` on the app.
 * AG-UI sends the whole conversation with every message, so the co-pilot routes get a larger JSON limit
 * (COPILOT_MAX_BODY); all other routes keep express's default (100kb). Both keep `rawBody`.
 */
export function configureBodyParsing(app: INestApplication, globalPrefix = '/api'): void {
  const expressApp = app as NestExpressApplication;
  const limit = process.env.COPILOT_MAX_BODY || DEFAULT_COPILOT_MAX_BODY;
  // The first parser to run marks the request as parsed, so the default one below skips co-pilot requests.
  expressApp.use(`${globalPrefix}/v1/mastra`, express.json({ limit, verify: keepRawBody }));
  expressApp.use(express.json({ verify: keepRawBody }));
  expressApp.use(express.urlencoded({ extended: true, verify: keepRawBody }));
}
