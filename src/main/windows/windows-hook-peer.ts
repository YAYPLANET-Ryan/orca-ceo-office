import { getWindowsProcessMetadataQueries } from './windows-process-table'

export function windowsProcessBirthMilliseconds(key: string): number | null {
  if (!/^\d{15,20}$/.test(key)) {
    return null
  }
  const value = Number(BigInt(key) / 10000n - 11644473600000n)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function readWindowsProcessCreationKey(pid: number): string | null {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return null
  }
  try {
    const value = getWindowsProcessMetadataQueries()?.getProcessCreationTimeKey?.(pid)
    return typeof value === 'string' && /^\d{15,20}$/.test(value) ? value : null
  } catch {
    return null
  }
}

export function readWindowsLoopbackTcpPeer(
  serverPort: number,
  clientPort: number
): { pid: number; creationTimeKey: string } | null {
  if (
    process.platform !== 'win32' ||
    ![serverPort, clientPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)
  ) {
    return null
  }
  try {
    const value = getWindowsProcessMetadataQueries()?.getLoopbackTcpPeer?.(serverPort, clientPort)
    return value &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 1 &&
      value.pid <= 0xffffffff &&
      typeof value.creationTimeKey === 'string' &&
      /^\d{15,20}$/.test(value.creationTimeKey)
      ? { pid: value.pid, creationTimeKey: value.creationTimeKey }
      : null
  } catch {
    return null
  }
}
