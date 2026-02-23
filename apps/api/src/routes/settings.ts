import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, isNull, type SQL } from 'drizzle-orm';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { settings, ID_LENGTH, S3_PATHS, DEFAULT_SETTINGS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { s3Client } from '../s3.js';

/* ─── Helpers ────────────────────────────────────────────── */

function orgCondition(orgId: string | null | undefined): SQL {
  return orgId ? eq(settings.orgId, orgId) : isNull(settings.orgId);
}

function formatRow(row: typeof settings.$inferSelect) {
  return {
    primaryColor: row.primaryColor,
    theme: row.theme,
    logoUrl: row.logoKey ? `${env.S3_PUBLIC_BASE_URL}/${row.logoKey}` : null,
    aiAutoTranscribe: row.aiAutoTranscribe === 'true',
    aiAutoChapter: row.aiAutoChapter === 'true',
  };
}

async function ensureSettingsRow(orgId: string | null | undefined) {
  const condition = orgCondition(orgId);
  const [existing] = await db.select().from(settings).where(condition).limit(1);
  if (existing) return existing;

  const id = nanoid(ID_LENGTH.SETTINGS);
  await db.insert(settings).values({
    id,
    orgId: orgId ?? null,
    primaryColor: DEFAULT_SETTINGS.PRIMARY_COLOR,
    theme: DEFAULT_SETTINGS.THEME,
    aiAutoTranscribe: String(DEFAULT_SETTINGS.AI_AUTO_TRANSCRIBE),
    aiAutoChapter: String(DEFAULT_SETTINGS.AI_AUTO_CHAPTER),
  });
  const [row] = await db.select().from(settings).where(condition).limit(1);
  return row!;
}

/* ─── Validation ─────────────────────────────────────────── */

const updateBody = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color').optional(),
  theme: z.enum(['light', 'dark']).optional(),
  aiAutoTranscribe: z.boolean().optional(),
  aiAutoChapter: z.boolean().optional(),
});

/* ─── Routes ─────────────────────────────────────────────── */

export async function settingsRoutes(app: FastifyInstance) {

  /* ── Public endpoint (no auth) for embed/watch pages ────── */
  app.get('/v1/settings/public', async () => {
    const [row] = await db.select().from(settings).where(isNull(settings.orgId)).limit(1);
    return {
      data: {
        primaryColor: row?.primaryColor ?? DEFAULT_SETTINGS.PRIMARY_COLOR,
        theme: row?.theme ?? DEFAULT_SETTINGS.THEME,
        logoUrl: row?.logoKey ? `${env.S3_PUBLIC_BASE_URL}/${row.logoKey}` : null,
      },
    };
  });

  /* ── GET settings ──────────────────────────────────────── */
  app.get('/v1/settings', async (request: FastifyRequest) => {
    const row = await ensureSettingsRow(request.orgId);
    return { data: formatRow(row) };
  });

  /* ── PATCH settings ────────────────────────────────────── */
  app.patch('/v1/settings', async (request: FastifyRequest) => {
    const body = updateBody.parse(request.body);
    const row = await ensureSettingsRow(request.orgId);

    const updates: Record<string, string> = {};
    if (body.primaryColor !== undefined) updates.primaryColor = body.primaryColor;
    if (body.theme !== undefined) updates.theme = body.theme;
    if (body.aiAutoTranscribe !== undefined) updates.aiAutoTranscribe = String(body.aiAutoTranscribe);
    if (body.aiAutoChapter !== undefined) updates.aiAutoChapter = String(body.aiAutoChapter);

    if (Object.keys(updates).length > 0) {
      await db.update(settings).set(updates).where(eq(settings.id, row.id));
    }

    const [updated] = await db.select().from(settings).where(eq(settings.id, row.id)).limit(1);
    return { data: formatRow(updated!) };
  });

  /* ── PUT logo upload (binary) ──────────────────────────── */
  app.register(async function logoUpload(scope) {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      done(null, payload);
    });

    scope.put<{ Body: AsyncIterable<Buffer> }>('/v1/settings/logo', {
      bodyLimit: 5_242_880, // 5 MB
    }, async (request) => {
      const row = await ensureSettingsRow(request.orgId);

      const contentType = request.headers['content-type'] || 'image/png';
      const extMap: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/svg+xml': 'svg',
        'image/webp': 'webp',
      };
      const ext = extMap[contentType] || 'png';
      const logoKey = `${S3_PATHS.SETTINGS_PREFIX}/${row.id}/logo.${ext}`;

      const chunks: Buffer[] = [];
      for await (const chunk of request.body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      await s3Client.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: logoKey,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      }));

      await db.update(settings).set({ logoKey }).where(eq(settings.id, row.id));

      return {
        data: { logoUrl: `${env.S3_PUBLIC_BASE_URL}/${logoKey}` },
      };
    });
  });

  /* ── DELETE logo ───────────────────────────────────────── */
  app.delete('/v1/settings/logo', async (request: FastifyRequest) => {
    const condition = orgCondition(request.orgId);
    const [row] = await db.select().from(settings).where(condition).limit(1);

    if (!row?.logoKey) {
      return { data: { deleted: false } };
    }

    await s3Client.send(new DeleteObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: row.logoKey,
    }));

    await db.update(settings).set({ logoKey: null }).where(eq(settings.id, row.id));
    return { data: { deleted: true } };
  });
}
