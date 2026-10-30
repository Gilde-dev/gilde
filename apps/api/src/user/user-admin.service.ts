import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';

import type { AdminUserDto, InviteUserDto, SetAdminDto, SetupLinkDto, UserResponseDto } from './user.dto.js';
import { UserAudit, type UserAuditAction } from './user-audit.entity.js';
import { UserSetupToken, type SetupTokenPurpose } from './user-setup-token.entity.js';
import { User } from './user.entity.js';
import { UserMapper } from './user.mapper.js';
import { UserService, hashPassword, normalizeEmail } from './user.service.js';
import { isUniqueViolation } from '../common/db-errors.js';

export const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const INVALID_SETUP_LINK = 'This link is invalid or has expired';

export function hashSetupToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function webOrigin(): string {
    return (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** User management for admins: accounts with one-time setup links, reset links, deactivation and the admin flag. Everything is audited. */
@Injectable()
export class UserAdminService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly users: UserService,
        private readonly mapper: UserMapper,
    ) { }

    async list(actor: AuthUser | undefined): Promise<AdminUserDto[]> {
        await this.users.requireAdmin(actor);
        const rows = await this.dataSource.getRepository(User).find({ order: { createdAt: 'ASC', id: 'ASC' } });
        return rows.map((u) => this.mapper.toAdminDTO(u));
    }

    /** Creates a human account without a usable password and returns its setup link. */
    async invite(actor: AuthUser | undefined, dto: InviteUserDto): Promise<SetupLinkDto> {
        const admin = await this.users.requireAdmin(actor);
        const email = normalizeEmail(dto.email);
        // A random password nobody knows: the account only becomes usable through the setup link.
        const password = await hashPassword(randomBytes(32).toString('hex'));
        try {
            return await this.dataSource.transaction(async (m) => {
                if (await m.getRepository(User).existsBy({ email })) throw new ConflictException(`A user with email ${email} already exists`);
                const user = await m.getRepository(User).save(m.getRepository(User).create({ name: dto.name.trim(), email, isBot: false, password }));
                await this.audit(m, admin.id, user.id, 'user_created');
                return this.issueLink(m, admin.id, user, 'setup');
            });
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`A user with email ${email} already exists`);
            throw e;
        }
    }

    /** A new link to set a password; earlier unused links of the account stop working. */
    async resetLink(actor: AuthUser | undefined, id: string): Promise<SetupLinkDto> {
        const admin = await this.users.requireAdmin(actor);
        return this.dataSource.transaction(async (m) => {
            const user = await this.target(m, id);
            if (user.deactivatedAt) throw new ConflictException('Reactivate the user before creating a link');
            await this.audit(m, admin.id, user.id, 'reset_link_created');
            return this.issueLink(m, admin.id, user, 'reset');
        });
    }

    async deactivate(actor: AuthUser | undefined, id: string): Promise<AdminUserDto> {
        const admin = await this.users.requireAdmin(actor);
        const result = await this.dataSource.transaction(async (m) => {
            const user = await this.target(m, id);
            if (user.id === admin.id) throw new ConflictException('You cannot deactivate yourself');
            if (user.deactivatedAt) return user;
            if (user.isAdmin && await this.activeAdmins(m) <= 1) throw new ConflictException('The last admin cannot be deactivated');
            user.deactivatedAt = new Date();
            user.deactivatedById = admin.id;
            await m.getRepository(User).update({ id }, { deactivatedAt: user.deactivatedAt, deactivatedById: admin.id });
            await this.audit(m, admin.id, id, 'deactivated');
            return user;
        });
        this.users.forgetActive(id);
        return this.mapper.toAdminDTO(result);
    }

    async reactivate(actor: AuthUser | undefined, id: string): Promise<AdminUserDto> {
        const admin = await this.users.requireAdmin(actor);
        const result = await this.dataSource.transaction(async (m) => {
            const user = await this.target(m, id);
            if (!user.deactivatedAt) return user;
            user.deactivatedAt = null;
            user.deactivatedById = null;
            await m.getRepository(User).update({ id }, { deactivatedAt: null, deactivatedById: null });
            await this.audit(m, admin.id, id, 'reactivated');
            return user;
        });
        this.users.forgetActive(id);
        return this.mapper.toAdminDTO(result);
    }

    async setAdmin(actor: AuthUser | undefined, id: string, dto: SetAdminDto): Promise<AdminUserDto> {
        const admin = await this.users.requireAdmin(actor);
        return this.dataSource.transaction(async (m) => {
            const user = await this.target(m, id);
            if (user.isAdmin === dto.isAdmin) return this.mapper.toAdminDTO(user);
            if (dto.isAdmin && user.deactivatedAt) throw new ConflictException('Reactivate the user before making them an admin');
            if (!dto.isAdmin && !user.deactivatedAt && await this.activeAdmins(m) <= 1) throw new ConflictException('The last admin cannot be removed');
            user.isAdmin = dto.isAdmin;
            await m.getRepository(User).update({ id }, { isAdmin: dto.isAdmin });
            await this.audit(m, admin.id, id, dto.isAdmin ? 'admin_granted' : 'admin_revoked');
            return this.mapper.toAdminDTO(user);
        });
    }

    /**
     * Sets the password from a setup or reset link. The token is consumed with a conditional update, so concurrent uses
     * succeed at most once. Every failure is the same generic 400.
     */
    async completeSetup(token: string, password: string): Promise<UserResponseDto> {
        const hash = await hashPassword(password);
        const user = await this.dataSource.transaction(async (m) => {
            const now = new Date();
            const row = await m.getRepository(UserSetupToken).findOneBy({ tokenHash: hashSetupToken(token) });
            if (!row) return null;
            const consumed = await m.getRepository(UserSetupToken).update(
                { id: row.id, usedAt: IsNull(), expiresAt: MoreThan(now) },
                { usedAt: now },
            );
            if (consumed.affected !== 1) return null;
            const found = await m.getRepository(User).findOneBy({ id: row.userId });
            if (!found || found.deactivatedAt || found.isBot) throw new BadRequestException(INVALID_SETUP_LINK);
            await m.getRepository(User).update({ id: found.id }, { password: hash });
            await this.audit(m, found.id, found.id, 'setup_completed');
            return found;
        }).catch((e: unknown) => {
            if (e instanceof BadRequestException) return null;
            throw e;
        });
        if (!user) throw new BadRequestException(INVALID_SETUP_LINK);
        return this.mapper.toDTO(user);
    }

    private async target(m: EntityManager, id: string): Promise<User> {
        const user = await m.getRepository(User).findOneBy({ id });
        if (!user) throw new NotFoundException(`User ${id} not found`);
        if (user.isBot) throw new ConflictException('Bot accounts are not managed here');
        return user;
    }

    private activeAdmins(m: EntityManager): Promise<number> {
        return m.getRepository(User).countBy({ isAdmin: true, deactivatedAt: IsNull() });
    }

    private audit(m: EntityManager, actorId: string, targetUserId: string, action: UserAuditAction): Promise<unknown> {
        return m.getRepository(UserAudit).insert({ actorId, targetUserId, action });
    }

    private async issueLink(m: EntityManager, createdById: string, user: User, purpose: SetupTokenPurpose): Promise<SetupLinkDto> {
        const tokens = m.getRepository(UserSetupToken);
        await tokens.delete({ userId: user.id, usedAt: IsNull() });
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + SETUP_LINK_TTL_MS);
        await tokens.insert({ userId: user.id, tokenHash: hashSetupToken(token), purpose, expiresAt, usedAt: null, createdById });
        return { user: this.mapper.toAdminDTO(user), setupLink: `${webOrigin()}/setup?token=${token}`, expiresAt: expiresAt.toISOString() };
    }
}
