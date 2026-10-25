import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { UserService } from './../../src/user/user.service.js';

export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
}

/** Creates a user with a unique email. */
export async function createTestUser(app: INestApplication, overrides: Partial<Pick<TestUser, 'name' | 'email'>> = {}): Promise<TestUser> {
  const user = await app.get(UserService, { strict: false }).create({
    name: overrides.name ?? 'Test User',
    email: overrides.email ?? `test-${randomUUID()}@example.com`,
    password: TEST_PASSWORD,
  });
  return { ...user, password: TEST_PASSWORD };
}

/** A valid token for the user, signed directly (logging in would hit the login throttle). */
export function tokenFor(app: INestApplication, user: Pick<TestUser, 'id' | 'email' | 'name'>, options: { expiresIn?: number } = {}): string {
  return app.get(JwtService, { strict: false }).sign(
    { sub: user.id, email: user.email, name: user.name },
    options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {},
  );
}

/** Creates a user and returns the Authorization headers for it. */
export async function authHeaders(app: INestApplication): Promise<{ Authorization: string }> {
  const user = await createTestUser(app);
  return { Authorization: `Bearer ${tokenFor(app, user)}` };
}

/** A supertest agent that sends a valid token with every request. */
export async function authedAgent(app: INestApplication) {
  const headers = await authHeaders(app);
  return request.agent(app.getHttpServer()).set(headers);
}
