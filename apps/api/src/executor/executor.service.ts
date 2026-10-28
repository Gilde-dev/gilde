import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';

import type { AuthUser } from '../auth/auth.dto.js';
import { isUniqueViolation } from '../common/db-errors.js';
import { RepoService } from '../repo/repo.service.js';
import { UserService } from '../user/user.service.js';

import type { CreateExecutorDto, ExecutorResponseDto, ReplaceExecutorDto, ReplaceExecutorTokenDto } from './executor.dto.js';
import { Executor } from './executor.entity.js';
import { parseExhaustedBackoffMinutes } from './executor-exhaustion.js';
import { ExecutorMapper } from './executor.mapper.js';
import { ExecutorSecretService } from './executor-secret.service.js';

/** Executors are personal: every method takes the acting user, and another user's executor is a 404. Writes need a verified human. */
@Injectable()
export class ExecutorService {
    private readonly backoffMinutes = parseExhaustedBackoffMinutes();

    constructor(
        @InjectRepository(Executor) private readonly executors: Repository<Executor>,
        private readonly mapper: ExecutorMapper,
        private readonly secrets: ExecutorSecretService,
        private readonly users: UserService,
        private readonly repos: RepoService,
    ) { }

    async list(user: AuthUser | null): Promise<ExecutorResponseDto[]> {
        const rows = await this.executors.find({ where: { ownerId: this.ownerId(user) }, order: { name: 'ASC' } });
        return rows.map((e) => this.mapper.toDTO(e));
    }

    async get(user: AuthUser | null, id: string): Promise<ExecutorResponseDto> {
        return this.mapper.toDTO(await this.getOwned(this.ownerId(user), id));
    }

    async create(user: AuthUser | null, dto: CreateExecutorDto): Promise<ExecutorResponseDto> {
        const owner = await this.verifiedOwner(user);
        this.secrets.assertConfigured();
        const repoIds = await this.validRepoIds(dto.repoIds);
        await this.assertNameFree(owner, dto.name);
        const entity = this.executors.create({
            ownerId: owner,
            name: dto.name,
            kind: 'routine',
            fireUrl: dto.fireUrl,
            repoIds,
            ...(dto.maxConcurrent !== undefined && { maxConcurrent: dto.maxConcurrent }),
            dailyRunLimit: dto.dailyRunLimit ?? null,
            ...(dto.enabled !== undefined && { enabled: dto.enabled }),
            exhaustedUntil: null,
            ...this.tokenColumns(dto.token),
        });
        return this.mapper.toDTO(await this.save(entity, dto.name));
    }

    /** Replaces name, fireUrl, repoIds, maxConcurrent, dailyRunLimit and enabled; the token and exhaustion are untouched. */
    async replace(user: AuthUser | null, id: string, dto: ReplaceExecutorDto): Promise<ExecutorResponseDto> {
        const owner = await this.verifiedOwner(user);
        const entity = await this.getOwned(owner, id);
        const repoIds = await this.validRepoIds(dto.repoIds);
        if (dto.name !== entity.name) await this.assertNameFree(owner, dto.name);
        Object.assign(entity, {
            name: dto.name,
            fireUrl: dto.fireUrl,
            repoIds,
            maxConcurrent: dto.maxConcurrent,
            dailyRunLimit: dto.dailyRunLimit,
            enabled: dto.enabled,
        });
        return this.mapper.toDTO(await this.save(entity, dto.name));
    }

    async replaceToken(user: AuthUser | null, id: string, dto: ReplaceExecutorTokenDto): Promise<void> {
        const owner = await this.verifiedOwner(user);
        this.secrets.assertConfigured();
        await this.getOwned(owner, id);
        await this.executors.update({ id, ownerId: owner }, this.tokenColumns(dto.token));
    }

    /** Clears `exhaustedUntil` of the user's own executor, so it is usable again at once. */
    async resetExhaustion(user: AuthUser | null, id: string): Promise<ExecutorResponseDto> {
        const owner = await this.verifiedOwner(user);
        const entity = await this.getOwned(owner, id);
        await this.executors.update({ id, ownerId: owner }, { exhaustedUntil: null });
        entity.exhaustedUntil = null;
        return this.mapper.toDTO(entity);
    }

    async remove(user: AuthUser | null, id: string): Promise<void> {
        const owner = await this.verifiedOwner(user);
        const result = await this.executors.delete({ id, ownerId: owner });
        if (!result.affected) throw new NotFoundException(`Executor ${id} not found`);
    }

    /**
     * Internal, for the dispatcher only (never behind a route): the decrypted routine token of the executor. The caller must
     * not log it or put it in a DTO, prompt or notification.
     */
    async revealToken(id: string): Promise<string> {
        const row = await this.executors.findOne({
            where: { id },
            select: { id: true, tokenCiphertext: true, tokenIv: true, tokenTag: true, keyVersion: true },
        });
        if (!row) throw new NotFoundException(`Executor ${id} not found`);
        if (!row.tokenCiphertext || !row.tokenIv || !row.tokenTag) throw new ConflictException(`Executor ${id} has no token`);
        return this.secrets.decrypt({ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag, keyVersion: row.keyVersion });
    }

    /**
     * Internal, for the dispatcher only (never behind a route): all executors of one owner, entities without token columns.
     * `tokenLast4` is null exactly when no token is stored.
     */
    listForDispatch(ownerId: string): Promise<Executor[]> {
        return this.executors.find({ where: { ownerId }, order: { name: 'ASC' } });
    }

    /**
     * Internal, for the dispatcher only: marks the executor exhausted until `resetAt`, else now + the configured backoff.
     * Returns the new reset time only when this call started the exhaustion (the executor was usable), so a caller
     * notifies once per exhaustion; null when it was already exhausted or is gone.
     */
    async markExhausted(id: string, resetAt: Date | null, now = new Date()): Promise<Date | null> {
        const until = resetAt ?? new Date(now.getTime() + this.backoffMinutes * 60_000);
        const set = { exhaustedUntil: until };
        const fresh = await this.executors.update({ id, exhaustedUntil: IsNull() }, set);
        if (fresh.affected) return until;
        const expired = await this.executors.update({ id, exhaustedUntil: LessThanOrEqual(now) }, set);
        return expired.affected ? until : null;
    }

    private tokenColumns(token: string) {
        const encrypted = this.secrets.encrypt(token);
        return {
            tokenCiphertext: encrypted.ciphertext,
            tokenIv: encrypted.iv,
            tokenTag: encrypted.tag,
            keyVersion: encrypted.keyVersion,
            tokenLast4: token.slice(-4),
        };
    }

    private ownerId(user: AuthUser | null): string {
        if (!user?.id) throw new ForbiddenException('A signed-in user is required');
        return user.id;
    }

    private async verifiedOwner(user: AuthUser | null): Promise<string> {
        return (await this.users.requireVerifiedHuman(user ?? undefined)).id;
    }

    private async getOwned(ownerId: string, id: string): Promise<Executor> {
        const entity = await this.executors.findOneBy({ id, ownerId });
        if (!entity) throw new NotFoundException(`Executor ${id} not found`);
        return entity;
    }

    private async validRepoIds(ids: string[]): Promise<string[]> {
        const unique = [...new Set(ids)];
        const missing = await this.repos.findMissingIds(unique);
        if (missing.length) throw new NotFoundException(`Unknown repositories: ${missing.join(', ')}`);
        return unique;
    }

    private async assertNameFree(ownerId: string, name: string): Promise<void> {
        if (await this.executors.existsBy({ ownerId, name })) throw new ConflictException(`You already have an executor named ${name}`);
    }

    private async save(entity: Executor, name: string): Promise<Executor> {
        try {
            return await this.executors.save(entity);
        } catch (e) {
            if (isUniqueViolation(e)) throw new ConflictException(`You already have an executor named ${name}`);
            throw e;
        }
    }
}
