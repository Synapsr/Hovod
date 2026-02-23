import { writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { aiJobs, AI_JOB_STATUS, AI_STEP_STATUS, S3_PATHS } from '@hovod/db';
import { isAiConfigured, isChapteringConfigured, createWhisper, createLlm } from './provider-factory.js';
import { extractAudio } from './audio-extract.js';
import { generateVtt } from './subtitles.js';
import type { DrizzleInstance } from '../types.js';

export interface AiProcessOptions {
  assetId: string;
  aiJobId: string;
  sourcePath: string;
  outputDir: string;
  durationSec: number;
  db: DrizzleInstance;
  aiOptions?: { transcription?: boolean; subtitles?: boolean; chapters?: boolean };
}

/**
 * Runs the full AI processing pipeline:
 * 1. Extract audio from video (FFmpeg)
 * 2. Transcribe audio (Whisper API)
 * 3. Generate subtitles (VTT from segments)
 * 4. Generate chapters (LLM from transcript)
 *
 * Each step updates its status independently. Failures are non-fatal —
 * the asset remains READY regardless of AI outcome.
 */
export async function processAi(opts: AiProcessOptions): Promise<void> {
  const { assetId, aiJobId, sourcePath, outputDir, durationSec, db, aiOptions } = opts;

  if (!isAiConfigured() || aiOptions?.transcription === false) {
    await db.update(aiJobs).set({ status: AI_JOB_STATUS.SKIPPED }).where(eq(aiJobs.id, aiJobId));
    return;
  }

  const aiDir = path.join(outputDir, 'ai');
  await mkdir(aiDir, { recursive: true });

  const s3Prefix = `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}`;

  try {
    await db.update(aiJobs).set({ status: AI_JOB_STATUS.PROCESSING }).where(eq(aiJobs.id, aiJobId));

    /* Step 1: Extract audio */
    console.log('[ai] Extracting audio...');
    const audioPath = await extractAudio(sourcePath, aiDir);

    /* Step 2: Transcribe */
    console.log('[ai] Transcribing...');
    await db.update(aiJobs).set({ transcriptionStatus: AI_STEP_STATUS.PROCESSING }).where(eq(aiJobs.id, aiJobId));

    const whisper = createWhisper();
    const transcript = await whisper.transcribe(audioPath);

    const transcriptJson = JSON.stringify(transcript, null, 2);
    await writeFile(path.join(aiDir, 'transcript.json'), transcriptJson, 'utf-8');

    await db.update(aiJobs).set({
      transcriptionStatus: AI_STEP_STATUS.COMPLETED,
      transcriptPath: `${s3Prefix}/${S3_PATHS.AI_TRANSCRIPT}`,
      language: transcript.language,
    }).where(eq(aiJobs.id, aiJobId));

    // Clean up audio file — no longer needed
    await unlink(audioPath).catch(() => {});

    /* Step 3: Generate subtitles VTT */
    if (aiOptions?.subtitles !== false) {
      console.log('[ai] Generating subtitles...');
      await db.update(aiJobs).set({ subtitlesStatus: AI_STEP_STATUS.PROCESSING }).where(eq(aiJobs.id, aiJobId));

      const vtt = generateVtt(transcript);
      await writeFile(path.join(aiDir, 'subtitles.vtt'), vtt, 'utf-8');

      await db.update(aiJobs).set({
        subtitlesStatus: AI_STEP_STATUS.COMPLETED,
        subtitlesPath: `${s3Prefix}/${S3_PATHS.AI_SUBTITLES}`,
      }).where(eq(aiJobs.id, aiJobId));
    } else {
      await db.update(aiJobs).set({ subtitlesStatus: AI_STEP_STATUS.SKIPPED }).where(eq(aiJobs.id, aiJobId));
    }

    /* Step 4: Generate chapters (if LLM configured and not disabled) */
    if (isChapteringConfigured() && aiOptions?.chapters !== false) {
      console.log('[ai] Generating chapters...');
      await db.update(aiJobs).set({ chaptersStatus: AI_STEP_STATUS.PROCESSING }).where(eq(aiJobs.id, aiJobId));

      const llm = createLlm();
      const chapters = await llm.generateChapters(transcript.text, durationSec);
      const chaptersJson = JSON.stringify({ chapters }, null, 2);
      await writeFile(path.join(aiDir, 'chapters.json'), chaptersJson, 'utf-8');

      await db.update(aiJobs).set({
        chaptersStatus: AI_STEP_STATUS.COMPLETED,
        chaptersPath: `${s3Prefix}/${S3_PATHS.AI_CHAPTERS}`,
      }).where(eq(aiJobs.id, aiJobId));
    } else {
      await db.update(aiJobs).set({ chaptersStatus: AI_STEP_STATUS.SKIPPED }).where(eq(aiJobs.id, aiJobId));
    }

    /* Done */
    await db.update(aiJobs).set({ status: AI_JOB_STATUS.COMPLETED }).where(eq(aiJobs.id, aiJobId));
    console.log(`[ai] Completed for asset ${assetId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown AI error';
    console.error(`[ai] Failed for asset ${assetId}:`, message);
    await db.update(aiJobs).set({
      status: AI_JOB_STATUS.FAILED,
      errorMessage: message.slice(0, 1024),
    }).where(eq(aiJobs.id, aiJobId)).catch(() => {});
  }
}
