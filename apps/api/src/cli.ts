#!/usr/bin/env node
/**
 * Operator CLI — runs against the same env as the API.
 *
 *   node apps/api/dist/cli.js reset-password <email>
 *     Prints a one-time password-reset link (1 h). The self-host fallback when
 *     no email provider is configured; in the all-in-one image:
 *     `docker exec hovod hovod-cli reset-password <email>`.
 */
import { eq } from 'drizzle-orm';
import { users } from '@hovod/db';
import { db, pool } from './db.js';
import { createPasswordReset } from './routes/auth.js';

const USAGE = `Usage:
  hovod-cli reset-password <email>   print a one-time password-reset link (valid 1 hour)
`;

async function resetPassword(email: string | undefined): Promise<number> {
  if (!email) {
    process.stderr.write(USAGE);
    return 2;
  }
  const [user] = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user) {
    process.stderr.write(`No account with email ${email}\n`);
    return 1;
  }
  const { resetUrl, expiresAt } = await createPasswordReset(user.id);
  process.stdout.write(`Password reset link for ${user.email} (expires ${expiresAt.toISOString()}):\n\n  ${resetUrl}\n\n`);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'reset-password':
      return resetPassword(args[0]);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    default:
      process.stderr.write(`Unknown command "${command}"\n${USAGE}`);
      return 2;
  }
}

main()
  .then(async (code) => {
    await pool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
