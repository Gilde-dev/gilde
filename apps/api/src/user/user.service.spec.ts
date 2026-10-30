import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import type { User } from './user.entity.js';
import { UserMapper } from './user.mapper.js';
import { UserService } from './user.service.js';

const human = { id: '11111111-1111-4111-8111-111111111111', name: 'H', email: 'h@example.com', credential: 'jwt' as const };

function setup(existing: Partial<User> | null = null) {
    const saved: Partial<User>[] = [];
    const repo = {
        findOneBy: async ({ id, email }: { id?: string; email?: string }) =>
            id === human.id ? { id, email: human.email, isBot: false } : email && existing && existing.email === email ? existing : null,
        existsBy: async ({ email }: { email: string }) => !!existing && existing.email === email,
        create: (x: Partial<User>) => x,
        save: async (x: Partial<User>) => { saved.push(x); return { ...x, id: '22222222-2222-4222-8222-222222222222' }; },
    } as unknown as Repository<User>;
    const mapper = new UserMapper();
    return { service: new UserService(repo, mapper), saved };
}

describe('UserService.createBot', () => {
    it('creates a bot with a random hashed password and returns no password', async () => {
        const { service, saved } = setup();
        const res = await service.createBot(human, { name: ' Werkmeester ', email: 'Werkmeester@Example.com' });
        expect(res).toEqual({ id: expect.any(String), name: 'Werkmeester', email: 'werkmeester@example.com', isBot: true });
        expect(JSON.stringify(res)).not.toContain('password');
        expect(saved[0]?.isBot).toBe(true);
        expect(saved[0]?.password).toMatch(/^\$argon2id\$/);
    });

    it('generates a different password each time', async () => {
        const a = setup(); const b = setup();
        await a.service.createBot(human, { name: 'A', email: 'a@example.com' });
        await b.service.createBot(human, { name: 'A', email: 'a@example.com' });
        expect(a.saved[0]?.password).not.toEqual(b.saved[0]?.password);
    });

    it('refuses API keys', async () => {
        await expect(setup().service.createBot({ ...human, credential: 'api_key' }, { name: 'A', email: 'a@example.com' }))
            .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('answers 409 with the user:mark-bot hint for an existing non-bot', async () => {
        const { service } = setup({ email: 'a@example.com', isBot: false });
        const err = await service.createBot(human, { name: 'A', email: 'a@example.com' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).message).toContain('user:mark-bot --email a@example.com');
    });

    it('answers 409 without the hint for an existing bot', async () => {
        const { service } = setup({ email: 'a@example.com', isBot: true });
        const err = await service.createBot(human, { name: 'A', email: 'a@example.com' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).message).not.toContain('user:mark-bot');
    });
});
