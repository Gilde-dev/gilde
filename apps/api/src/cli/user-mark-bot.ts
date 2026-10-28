import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { databaseConfig } from '../database.config.js';
import { UserModule } from '../user/user.module.js';
import { UserService } from '../user/user.service.js';

import { parseMarkBotArgs } from './args.js';

@Module({
    imports: [TypeOrmModule.forRoot(databaseConfig()), UserModule],
})
class CliModule { }

async function main() {
    const { email } = parseMarkBotArgs(process.argv.slice(2));
    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
    try {
        const user = await app.get(UserService).markBot(email);
        console.log(`Marked ${user.email} (${user.id}) as a bot`);
    } finally {
        await app.close();
    }
}

main().catch((e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
