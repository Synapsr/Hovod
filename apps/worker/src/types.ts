import type { createDb } from '@hovod/db';

/** Drizzle ORM instance type inferred from the shared db factory */
export type DrizzleInstance = ReturnType<typeof createDb>['db'];
