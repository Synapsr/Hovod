import { createReadStream } from 'node:fs';
import { readdir, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

const UPLOAD_BATCH_SIZE = 10;
const MAX_RETRIES = 3;

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(`[s3] Upload failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

export async function uploadDirectory(root: string, prefix: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const entries = await readdir(root, { recursive: true });
  const filePaths: { fullPath: string; key: string }[] = [];

  for (const entry of entries) {
    const relativePath = entry.toString();
    const fullPath = path.resolve(root, relativePath);

    // Path traversal prevention: ensure file is within root
    if (!fullPath.startsWith(resolvedRoot)) continue;

    // Skip symlinks to prevent symlink-based attacks
    const linkStat = await lstat(fullPath);
    if (linkStat.isSymbolicLink()) continue;

    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) continue;

    filePaths.push({
      fullPath,
      key: `${prefix}/${relativePath.replaceAll('\\', '/')}`,
    });
  }

  for (let i = 0; i < filePaths.length; i += UPLOAD_BATCH_SIZE) {
    const batch = filePaths.slice(i, i + UPLOAD_BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ fullPath, key }) => {
        await withRetry(async () => {
          const body = createReadStream(fullPath);
          await s3.send(new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            Body: body,
            ACL: 'public-read',
          }));
        });
      })
    );
  }
}
