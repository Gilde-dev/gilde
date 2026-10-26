import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Production runs behind exactly one reverse proxy (Caddy): trust one hop so `req.ip` (and with it the login
 * throttle) is the real client address from X-Forwarded-For. Spoofed entries further left are ignored.
 */
export function configureProxy(app: INestApplication): void {
  (app as NestExpressApplication).set('trust proxy', 1);
}
