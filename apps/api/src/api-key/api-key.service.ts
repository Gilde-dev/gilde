import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IsNull, LessThan, Or, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { User } from '../user/user.entity.js';

import type { ApiKeyResponseDto, CreateApiKeyDto, CreatedApiKeyDto } from './api-key.dto.js';
import { ApiKey } from './api-key.entity.js';
import { ApiKeyMapper } from './api-key.mapper.js';

/** gk_<8 hex prefix>_<64 hex secret (32 random bytes)> */
const KEY_PATTERN = /^gk_([0-9a-f]{8})_([0-9a-f]{64})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const LAST_USED_THROTTLE_MS = 60_000;

export function isApiKeyToken(token: string): boolean {
    return token.startsWith('gk_');
}

export function hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
}

@Injectable()
export class ApiKeyService {
    constructor(
        @InjectRepository(ApiKey) private readonly keys: Repository<ApiKey>,
        @InjectRepository(User) private readonly users: Repository<User>,
        private readonly mapper: ApiKeyMapper,
    ) { }

    async create(userId: string, dto: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
        const secret = randomBytes(32).toString('hex');
        const expiresAt = dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * DAY_MS) : null;
        for (let attempt = 0; attempt < 5; attempt++) {
            const prefix = randomBytes(4).toString('hex');
            try {
                const saved = await this.keys.save(this.keys.create({
                    userId,
                    name: dto.name,
                    prefix,
                    secretHash: hashSecret(secret),
                    lastUsedAt: null,
                    expiresAt,
                    revokedAt: null,
                }));
                return {
                    id: saved.id,
                    name: saved.name,
                    prefix,
                    key: `gk_${prefix}_${secret}`,
                    expiresAt: expiresAt?.toISOString() ?? null,
                };
            } catch (e) {
                if (!isUniqueViolation(e)) throw e;
            }
        }
        throw new ConflictException('Could not generate a unique API key prefix, try again');
    }

    /** Active (not revoked) keys of the user, newest first. */
    async list(userId: string): Promise<ApiKeyResponseDto[]> {
        const rows = await this.keys.find({ where: { userId, revokedAt: IsNull() }, order: { createdAt: 'DESC' } });
        return rows.map((k) => this.mapper.toDTO(k));
    }

    async revoke(userId: string, id: string): Promise<void> {
        const key = await this.keys.findOneBy({ id, userId, revokedAt: IsNull() });
        if (!key) throw new NotFoundException(`API key ${id} not found`);
        await this.keys.update({ id }, { revokedAt: new Date() });
    }

    /** The key owner for a valid `gk_...` token, or null for unknown, malformed, revoked or expired keys and deleted users. */
    async authenticate(token: string): Promise<AuthUser | null> {
        const match = KEY_PATTERN.exec(token);
        if (!match) return null;
        const [, prefix, secret] = match;
        const key = await this.keys
            .createQueryBuilder('key')
            .addSelect('key.secretHash')
            .where('key.prefix = :prefix', { prefix })
            .getOne();
        if (!key) return null;

        const expected = Buffer.from(key.secretHash, 'hex');
        const actual = Buffer.from(hashSecret(secret), 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
        if (key.revokedAt) return null;
        if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

        const user = await this.users.findOneBy({ id: key.userId });
        if (!user || user.deactivatedAt) return null;

        await this.touch(key.id);
        return { id: user.id, name: user.name, email: user.email, credential: 'api_key' };
    }

    /** Sets last_used_at at most once per minute per key. */
    private async touch(id: string): Promise<void> {
        const now = new Date();
        await this.keys.update(
            { id, lastUsedAt: Or(IsNull(), LessThan(new Date(now.getTime() - LAST_USED_THROTTLE_MS))) },
            { lastUsedAt: now },
        );
    }
}
