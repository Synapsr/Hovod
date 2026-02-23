import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { assets, comments, reactions, ASSET_STATUS, ID_LENGTH, REACTION_EMOJIS } from '@hovod/db';
import { db } from '../db.js';
import { NotFoundError } from '../middleware/error-handler.js';

function emailToGravatarHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

const createCommentBody = z.object({
  authorName: z.string().trim().min(1).max(100),
  authorEmail: z.string().email().max(255),
  body: z.string().trim().min(1).max(2000),
  timestampSec: z.number().int().nonnegative().optional(),
});

const listCommentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const createReactionBody = z.object({
  emoji: z.enum(REACTION_EMOJIS),
  sessionId: z.string().min(1).max(64),
});

export async function commentRoutes(app: FastifyInstance) {
  /* POST /v1/playback/:playbackId/comments — Create a comment (public) */
  app.post<{ Params: { playbackId: string }; Body: z.infer<typeof createCommentBody> }>(
    '/v1/playback/:playbackId/comments',
    async (request, reply) => {
      const { playbackId } = request.params;
      const body = createCommentBody.parse(request.body);

      const [asset] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
        .limit(1);

      if (!asset) throw new NotFoundError('Playback not found');

      const id = nanoid(ID_LENGTH.COMMENT);
      const now = new Date();

      await db.insert(comments).values({
        id,
        assetId: asset.id,
        playbackId,
        authorName: body.authorName,
        authorEmail: body.authorEmail,
        body: body.body,
        timestampSec: body.timestampSec ?? null,
        createdAt: now,
      });

      reply.code(201);
      return {
        data: {
          id,
          authorName: body.authorName,
          emailHash: emailToGravatarHash(body.authorEmail),
          body: body.body,
          timestampSec: body.timestampSec ?? null,
          createdAt: now.toISOString(),
        },
      };
    },
  );

  /* GET /v1/playback/:playbackId/comments — List comments (public) */
  app.get<{ Params: { playbackId: string }; Querystring: z.infer<typeof listCommentsQuery> }>(
    '/v1/playback/:playbackId/comments',
    async (request) => {
      const { playbackId } = request.params;
      const { limit, offset } = listCommentsQuery.parse(request.query);

      const [asset] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
        .limit(1);

      if (!asset) throw new NotFoundError('Playback not found');

      const [rows, countResult] = await Promise.all([
        db
          .select()
          .from(comments)
          .where(eq(comments.playbackId, playbackId))
          .orderBy(desc(comments.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`COUNT(*)` })
          .from(comments)
          .where(eq(comments.playbackId, playbackId)),
      ]);

      return {
        data: {
          comments: rows.map((c) => ({
            id: c.id,
            authorName: c.authorName,
            emailHash: emailToGravatarHash(c.authorEmail),
            body: c.body,
            timestampSec: c.timestampSec,
            createdAt: c.createdAt.toISOString(),
          })),
          total: Number(countResult[0].count),
        },
      };
    },
  );

  /* ─── Reactions ─────────────────────────────────────────── */

  /* POST /v1/playback/:playbackId/reactions — Toggle a reaction (public) */
  app.post<{ Params: { playbackId: string }; Body: z.infer<typeof createReactionBody> }>(
    '/v1/playback/:playbackId/reactions',
    async (request) => {
      const { playbackId } = request.params;
      const body = createReactionBody.parse(request.body);

      const [asset] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
        .limit(1);

      if (!asset) throw new NotFoundError('Playback not found');

      // Check if this session already reacted with this emoji
      const [existing] = await db
        .select({ id: reactions.id })
        .from(reactions)
        .where(and(
          eq(reactions.playbackId, playbackId),
          eq(reactions.emoji, body.emoji),
          eq(reactions.sessionId, body.sessionId),
        ))
        .limit(1);

      if (existing) {
        // Remove reaction (toggle off)
        await db.delete(reactions).where(eq(reactions.id, existing.id));
      } else {
        // Add reaction (toggle on)
        await db.insert(reactions).values({
          id: nanoid(ID_LENGTH.REACTION),
          assetId: asset.id,
          playbackId,
          emoji: body.emoji,
          sessionId: body.sessionId,
        });
      }

      // Return updated counts
      const counts = await db
        .select({ emoji: reactions.emoji, count: sql<number>`COUNT(*)` })
        .from(reactions)
        .where(eq(reactions.playbackId, playbackId))
        .groupBy(reactions.emoji);

      // Get this session's reactions
      const sessionReactions = await db
        .select({ emoji: reactions.emoji })
        .from(reactions)
        .where(and(eq(reactions.playbackId, playbackId), eq(reactions.sessionId, body.sessionId)));

      const countsMap: Record<string, number> = {};
      for (const c of counts) countsMap[c.emoji] = Number(c.count);

      return {
        data: {
          counts: countsMap,
          userReactions: sessionReactions.map((r) => r.emoji),
        },
      };
    },
  );

  /* GET /v1/playback/:playbackId/reactions — Get reaction counts (public) */
  app.get<{ Params: { playbackId: string }; Querystring: { sessionId?: string } }>(
    '/v1/playback/:playbackId/reactions',
    async (request) => {
      const { playbackId } = request.params;
      const sessionId = (request.query as { sessionId?: string }).sessionId;

      const counts = await db
        .select({ emoji: reactions.emoji, count: sql<number>`COUNT(*)` })
        .from(reactions)
        .where(eq(reactions.playbackId, playbackId))
        .groupBy(reactions.emoji);

      const countsMap: Record<string, number> = {};
      for (const c of counts) countsMap[c.emoji] = Number(c.count);

      let userReactions: string[] = [];
      if (sessionId) {
        const rows = await db
          .select({ emoji: reactions.emoji })
          .from(reactions)
          .where(and(eq(reactions.playbackId, playbackId), eq(reactions.sessionId, sessionId)));
        userReactions = rows.map((r) => r.emoji);
      }

      return {
        data: {
          counts: countsMap,
          userReactions,
        },
      };
    },
  );
}
