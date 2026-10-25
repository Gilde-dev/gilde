import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { databaseConfig } from '../database.config.js';
import { CreateUserSchema, MIN_PASSWORD_LENGTH } from '../user/user.dto.js';
import { UserModule } from '../user/user.module.js';
import { UserService } from '../user/user.service.js';

import { parseUserCreateArgs } from './args.js';
import { promptHidden } from './prompt.js';

@Module({
    imports: [TypeOrmModule.forRoot(databaseConfig()), UserModule],
})
class CliModule { }

async function main() {
    const { email, name } = parseUserCreateArgs(process.argv.slice(2));

    const password = await promptHidden('Password: ');
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (password !== await promptHidden('Repeat password: ')) {
        throw new Error('Passwords do not match');
    }

    const parsed = CreateUserSchema.safeParse({ name, email, password });
    if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }

    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
    try {
        const user = await app.get(UserService).create(parsed.data);
        console.log(`Created user ${user.email} (${user.id})`);
    } finally {
        await app.close();
    }
}

main().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
