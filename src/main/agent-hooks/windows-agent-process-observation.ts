import type { AgentProcessObservation } from '../../shared/agent-status/process/agent-process-presence-probe'
import {
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from '../windows/windows-process-table'
import {
  readWindowsProcessCreationKey,
  windowsProcessBirthMilliseconds
} from '../windows/windows-hook-peer'

export function createWindowsAgentProcessObservationReader(
  readKey: (pid: number) => string | null = readWindowsProcessCreationKey,
  readTable: () => Promise<WindowsProcessIdentityRow[]> = readWindowsProcessIdentityTableFresh,
  selfPid = process.pid
): (pid: number) => Promise<AgentProcessObservation> {
  return async (pid) => {
    const key = readKey(pid)
    const birth = key ? windowsProcessBirthMilliseconds(key) : null
    if (birth !== null) {
      return { verdict: 'live', startTime: `win32:${birth}`, zombie: false }
    }
    if (!readKey(selfPid)) {
      return { verdict: 'unverifiable' }
    }
    const rows = await readTable()
    if (!rows.some((row) => row.pid === selfPid) || rows.some((row) => row.pid === pid)) {
      return { verdict: 'unverifiable' }
    }
    return { verdict: 'exited' }
  }
}
