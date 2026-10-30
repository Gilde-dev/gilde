import type { QueryRunner } from 'typeorm';

/**
 * Makes the oldest human (non-bot) account an admin when nobody is one yet, so an existing installation keeps a way to
 * manage users. Returns the email it promoted, or null when an admin exists or there is no human account.
 * Plain SQL with true/false literals, which Postgres and SQLite (3.23+) both accept.
 */
export async function seedFirstAdmin(queryRunner: QueryRunner): Promise<string | null> {
    const admins: unknown[] = await queryRunner.query('SELECT id FROM users WHERE is_admin = true LIMIT 1');
    if (admins.length > 0) return null;
    const oldest: { id: string; email: string }[] = await queryRunner.query('SELECT id, email FROM users WHERE is_bot = false ORDER BY created_at ASC, id ASC LIMIT 1');
    if (oldest.length === 0) return null;
    await queryRunner.query(`UPDATE users SET is_admin = true WHERE id = '${oldest[0].id}'`);
    return oldest[0].email;
}
