import { eq } from 'drizzle-orm';
import { organizations, type WebhookEvent } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';

const TIMEOUT_MS = 10_000;

interface WebhookPayload {
  type: WebhookEvent;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Dispatch a webhook event.
 *
 * Fires to the WEBHOOK_URL env var (if set) and to the org's configured
 * webhookUrl (if set). All calls are fire-and-forget — failures are logged
 * but never thrown.
 */
export async function dispatchWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>,
  orgId?: string | null,
): Promise<void> {
  const urls: string[] = [];

  // Global webhook URL from environment
  if (env.WEBHOOK_URL) {
    urls.push(env.WEBHOOK_URL);
  }

  // Org-specific webhook URL
  if (orgId) {
    try {
      const [org] = await db.select({ webhookUrl: organizations.webhookUrl })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (org?.webhookUrl) urls.push(org.webhookUrl);
    } catch { /* non-fatal */ }
  }

  if (urls.length === 0) return;

  const payload: WebhookPayload = {
    type: event,
    data,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);

  // Fire-and-forget — log errors but never throw
  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        console.warn(`[webhook] Failed to deliver ${event} to ${url}: ${(err as Error).message}`);
      }
    }),
  );
}
