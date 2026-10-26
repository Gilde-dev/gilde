import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request } from 'express';

import { hasValidIngestToken, isJsonContentType, otelIngestConfig } from './otel.config.js';

/**
 * The only authentication of the OTLP routes (they are @Public() so the global JwtAuthGuard steps aside, also with
 * AUTH_ENABLED=false). Order: disabled -> 404, bad or missing bearer -> 401, not application/json -> 415.
 * JWTs and gk_ API keys never match the ingest token, and the ingest token is not a JWT or API key.
 */
@Injectable()
export class OtelIngestGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        const config = otelIngestConfig();
        if (config.state !== 'enabled') throw new NotFoundException();
        if (!hasValidIngestToken(req.headers.authorization, config)) throw new UnauthorizedException();
        if (!isJsonContentType(req.headers['content-type'])) {
            throw new UnsupportedMediaTypeException('OTLP/HTTP JSON only: send Content-Type: application/json (set OTEL_EXPORTER_OTLP_PROTOCOL=http/json)');
        }
        return true;
    }
}
