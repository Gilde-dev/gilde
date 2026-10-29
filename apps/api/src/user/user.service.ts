import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { requirePersistedHuman, requireVerifiedHuman } from '../common/verified-human.js';
import { isUniqueViolation } from '../common/db-errors.js';

import type { CreateUserDto, UserIdentityDto, UserProfileDto, UserResponseDto } from './user.dto.js';
import { User } from './user.entity.js';
import { UserMapper } from './user.mapper.js';

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
}

@Injectable()
export class UserService {
    constructor(
        @InjectRepository(User) private readonly users: Repository<User>,
        private readonly mapper: UserMapper,
    ) { }

    async create(dto: CreateUserDto, options: { isBot?: boolean } = {}): Promise<UserResponseDto> {
        const email = normalizeEmail(dto.email);
        if (await this.users.existsBy({ email })) {
            throw new ConflictException(`A user with email ${email} already exists`);
        }
        try {
            const saved = await this.users.save(this.users.create({
                name: dto.name.trim(),
                email,
                isBot: options.isBot === true,
                password: await hashPassword(dto.password),
            }));
            return this.mapper.toDTO(saved);
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`A user with email ${email} already exists`);
            throw e;
        }
    }

    async getById(id: string): Promise<UserResponseDto> {
        const user = await this.users.findOneBy({ id });
        if (!user) throw new NotFoundException(`User ${id} not found`);
        return this.mapper.toDTO(user);
    }

    async findByEmail(email: string): Promise<UserResponseDto | null> {
        const user = await this.users.findOneBy({ email: normalizeEmail(email) });
        return user ? this.mapper.toDTO(user) : null;
    }

    /** Marks the account as a bot. Idempotent; never touches the password. */
    async markBot(email: string): Promise<UserResponseDto> {
        const normalized = normalizeEmail(email);
        const user = await this.users.findOneBy({ email: normalized });
        if (!user) throw new NotFoundException(`No user with email ${normalized}`);
        if (!user.isBot) await this.users.update({ id: user.id }, { isBot: true });
        return this.mapper.toDTO(user);
    }

    /** Name, email and bot status of one account, or null for a deleted user. */
    async findProfile(id: string): Promise<UserProfileDto | null> {
        const user = await this.users.findOneBy({ id });
        return user ? this.mapper.toProfileDTO(user) : null;
    }

    /** The accounts marked as bots, by name: what an agent's bot user is chosen from. */
    async listBots(): Promise<UserProfileDto[]> {
        const bots = await this.users.find({ where: { isBot: true }, order: { name: 'ASC' } });
        return bots.map((u) => this.mapper.toProfileDTO(u));
    }

    /** The current persisted identity (bot status included), or null for a deleted user. */
    async findIdentity(id: string): Promise<UserIdentityDto | null> {
        const user = await this.users.findOneBy({ id });
        return user ? this.mapper.toIdentityDTO(user) : null;
    }

    /**
     * Opt-in gate for human-only operations: the caller must be a persisted, non-bot account that authenticated with a
     * verified JWT. Reads the account fresh, so a stale token cannot outlive a bot marking or a deletion.
     */
    async requireVerifiedHuman(user: AuthUser | undefined): Promise<UserIdentityDto> {
        const persisted = user?.credential === 'jwt' ? await this.findIdentity(user.id) : null;
        return requireVerifiedHuman(user, persisted);
    }

    /**
     * Gate for operators acting through MCP: the request must carry server-set JWT or API-key provenance and its account must
     * still exist as a non-bot, non-scout user, read fresh. Unlike requireVerifiedHuman, personal API keys qualify.
     */
    async requireOperator(user: AuthUser | undefined): Promise<UserIdentityDto> {
        const trusted = user?.credential === 'jwt' || user?.credential === 'api_key';
        const persisted = user && trusted ? await this.findIdentity(user.id) : null;
        if (!user?.id || !trusted) throw new ForbiddenException('Authentication with a JWT or personal API key is required');
        return requirePersistedHuman(user, persisted);
    }

    /** Internal: the only place the password hash is loaded. Returns the entity, not a DTO. */
    findByEmailWithPassword(email: string): Promise<User | null> {
        return this.users
            .createQueryBuilder('user')
            .addSelect('user.password')
            .where('user.email = :email', { email: normalizeEmail(email) })
            .getOne();
    }
}
