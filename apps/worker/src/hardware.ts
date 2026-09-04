import { readFileSync } from 'node:fs';
import os from 'node:os';

export interface HardwareInfo {
  cpuCores: number;
  totalMemBytes: number;
  cpuSource: 'cgroup-v2' | 'os';
  memSource: 'cgroup-v2' | 'os';
}

function readCgroupFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * CPU limit from cgroup v2 (`/sys/fs/cgroup/cpu.max` → "<quota> <period>" or
 * "max <period>"). Returns null when unlimited or unavailable.
 */
export function readCgroupCpuLimit(file = '/sys/fs/cgroup/cpu.max'): number | null {
  const raw = readCgroupFile(file);
  if (!raw) return null;
  const [quotaStr, periodStr] = raw.split(/\s+/);
  if (!quotaStr || quotaStr === 'max') return null;
  const quota = Number(quotaStr);
  const period = Number(periodStr) || 100_000;
  if (!Number.isFinite(quota) || quota <= 0) return null;
  return Math.max(1, Math.ceil(quota / period));
}

/**
 * Memory limit from cgroup v2 (`/sys/fs/cgroup/memory.max` → bytes or "max").
 * Returns null when unlimited or unavailable.
 */
export function readCgroupMemoryLimit(file = '/sys/fs/cgroup/memory.max'): number | null {
  const raw = readCgroupFile(file);
  if (!raw || raw === 'max') return null;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes;
}

/**
 * Detects the effective CPU and memory budget: cgroup v2 limits when the
 * process runs in a constrained container, otherwise the host values.
 */
export function detectHardware(): HardwareInfo {
  const hostCores = Math.max(1, os.cpus().length || 1);
  const hostMem = os.totalmem();

  const cgroupCpu = readCgroupCpuLimit();
  const cgroupMem = readCgroupMemoryLimit();

  const cpuCores = cgroupCpu !== null ? Math.min(cgroupCpu, hostCores) : hostCores;
  const totalMemBytes = cgroupMem !== null ? Math.min(cgroupMem, hostMem) : hostMem;

  return {
    cpuCores,
    totalMemBytes,
    cpuSource: cgroupCpu !== null ? 'cgroup-v2' : 'os',
    memSource: cgroupMem !== null ? 'cgroup-v2' : 'os',
  };
}
