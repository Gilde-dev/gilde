import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { Repository } from 'typeorm';

import { isUniqueViolation } from '../common/db-errors.js';

import type { CreateUserDto, UserResponseDto } from './user.dto.js';
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

    async create(dto: CreateUserDto): Promise<UserResponseDto> {
        const email = normalizeEmail(dto.email);
        if (await this.users.existsBy({ email })) {
            throw new ConflictException(`A user with email ${email} already exists`);
        }
        try {
            const saved = await this.users.save(this.users.create({
                name: dto.name.trim(),
                email,
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

    /** Internal: the only place the password hash is loaded. Returns the entity, not a DTO. */
    findByEmailWithPassword(email: string): Promise<User | null> {
        return this.users
            .createQueryBuilder('user')
            .addSelect('user.password')
            .where('user.email = :email', { email: normalizeEmail(email) })
            .getOne();
    }
}
