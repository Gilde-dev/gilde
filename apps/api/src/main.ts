import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { assertAuthConfig, authEnabled } from './auth/auth.config.js';

const port = process.env.PORT ?? 4100;

async function bootstrap() {
  try {
    assertAuthConfig();
  } catch (e) {
    console.error(`Refusing to start: ${(e as Error).message}`);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    rawBody: true,
  });

  app.setGlobalPrefix('/api');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });

  if (!authEnabled()) {
    new Logger('Auth').warn('AUTH_ENABLED=false: the API is unauthenticated, every request is allowed');
  }

  await app.listen(port);
  console.log(`Now listening on *:${port}`)
}
await bootstrap();
