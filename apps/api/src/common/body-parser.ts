import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';

import { OTEL_MAX_BODY, hasValidIngestToken, isOtelIngestPath, otelIngestConfig } from '../otel/otel.config.js';

export const DEFAULT_COPILOT_MAX_BODY = '10mb';

/** Keeps the exact bytes received; the GitHub webhook signature is computed over them. */
function keepRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
}

/**
 * Registers the body parsers. Use it with `bodyParser: false` on the app.
 * AG-UI sends the whole conversation with every message, so the co-pilot routes get a larger JSON limit
 * (COPILOT_MAX_BODY); all other routes keep express's default (100kb). Both keep `rawBody`.
 *
 * The two OTLP ingest routes (`/v1/otel/v1/logs|metrics`) are the exception: a JSON-only parser with a 5 MB limit
 * that does not keep `rawBody`, and it only runs for requests that carry the valid OTEL_INGEST_TOKEN. Everything
 * else on those paths (disabled, no or wrong token) is never parsed or buffered, so it is answered by the route's
 * guard (404/401) and a large body without credentials cannot get 413 or use memory. Order for a valid token:
 * 413 (parser) -> 415 (guard, not application/json) -> 400 (malformed JSON or envelope) -> 200.
 */
export function configureBodyParsing(app: INestApplication, globalPrefix = '/api'): void {
  const expressApp = app as NestExpressApplication;
  const limit = process.env.COPILOT_MAX_BODY || DEFAULT_COPILOT_MAX_BODY;

  const otelJson = express.json({ limit: OTEL_MAX_BODY });
  expressApp.use(((req, res, next) => {
    if (!isOtelIngestPath(req.path, globalPrefix)) return next();
    if (hasValidIngestToken(req.headers.authorization, otelIngestConfig())) return otelJson(req, res, next);
    next();
  }) as RequestHandler);
  const skipOtel = (parser: RequestHandler): RequestHandler => (req, res, next) =>
    isOtelIngestPath(req.path, globalPrefix) ? next() : parser(req, res, next);

  // The first parser to run marks the request as parsed, so the default one below skips co-pilot requests.
  expressApp.use(`${globalPrefix}/v1/mastra`, express.json({ limit, verify: keepRawBody }));
  expressApp.use(skipOtel(express.json({ verify: keepRawBody })));
  expressApp.use(skipOtel(express.urlencoded({ extended: true, verify: keepRawBody })));
}
