import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour default

export async function runFfmpeg(args: string[], timeoutMs?: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => proc.kill('SIGKILL'), 5000);
      reject(new Error('FFmpeg process timed out'));
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killed) return; // Already rejected by timeout
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

export async function ffprobe(filePath: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffprobe: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}`));
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] ?? {};
        const duration = parseFloat(stream.duration || data.format?.duration || '0');
        resolve({ width: stream.width || 0, height: stream.height || 0, duration });
      } catch {
        reject(new Error('Failed to parse ffprobe output'));
      }
    });
  });
}
