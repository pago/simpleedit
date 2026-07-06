/** Machine profiling for hardware-aware model recommendations. */
import os from 'os'
import { execFileSync } from 'child_process'
import type { HardwareInfo } from '../../shared/ipc-types'

/** On macOS the CPU brand string names the Apple Silicon chip (e.g. "Apple M4 Pro"). */
function detectChip(): string {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
        encoding: 'utf-8',
      }).trim()
      if (out) return out
    } catch {
      // fall through to the generic os.cpus() model
    }
  }
  return os.cpus()[0]?.model ?? 'unknown'
}

export function detectHardware(): HardwareInfo {
  return {
    totalRamBytes: os.totalmem(),
    chip: detectChip(),
    platform: process.platform,
  }
}
