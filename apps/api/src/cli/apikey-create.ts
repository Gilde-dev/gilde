import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeyModule } from '../api-key/api-key.module.js';
import { CreateApiKeySchema } from '../api-key/api-key.dto.js';
import { ApiKeyService } from '../api-key/api-key.service.js';
import { databaseConfig } from '../database.config.js';
import { UserModule } from '../user/user.module.js';
import { normalizeEmail, UserService } from '../user/user.service.js';

import { parseApiKeyCreateArgs } from './args.js';

@Module({
    imports: [TypeOrmModule.forRoot(databaseConfig()), UserModule, ApiKeyModule],
})
class CliModule { }

async function main() {
    const { email, name } = parseApiKeyCreateArgs(process.argv.slice(2));
    const parsed = CreateApiKeySchema.safeParse({ name });
    if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }

    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
    try {
        const user = await app.get(UserService).findByEmail(normalizeEmail(email));
        if (!user) throw new Error(`No user with email ${normalizeEmail(email)} (create one with user:create)`);
        const created = await app.get(ApiKeyService).create(user.id, parsed.data);
        console.log(`Created API key "${created.name}" for ${user.email}. It is shown only once:\n\n${created.key}\n`);
    } finally {
        await app.close();
    }
}

main().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
