/** PID/parent/name identity, with native creation time when available. */
export type WindowsProcessIdentityRow = {
  pid: number
  ppid: number
  name: string
  /** Process creation time in Unix milliseconds, when the native snapshot provides it. */
  creationTimeMs?: number
}

/** Adds the kernel-supplied command line. Only ask for this if you read it. */
export type WindowsProcessRow = WindowsProcessIdentityRow & {
  /** Full command line. Empty when the process denied a query handle. */
  command: string
}

export type NativeProcessInfo = {
  pid: number
  ppid: number
  name: string
  commandLine?: string
  creationTimeMs?: number
}

/** node-addon-api's default OnError hands the callback an Error (e.g. bad_alloc) instead of rows. */
export type NativeProcessSnapshot = NativeProcessInfo[] | Error | undefined

export type WindowsProcessTreeModule = {
  ProcessDataFlag: {
    None: number
    CommandLine: number
    CreationTime?: number
  }
  /** Compiled addon capabilities; patched JS enums may sit above an older prebuilt binary. */
  supportedProcessDataFlags?: number
  getProcessCreationTime?: (pid: number) => number | undefined
  getProcessCreationTimeKey?: (pid: number) => string | undefined
  getLoopbackTcpPeer?: (
    serverPort: number,
    clientPort: number
  ) => { pid: number; creationTimeKey: string } | undefined
  getAllProcesses: (callback: (processes: NativeProcessSnapshot) => void, flags?: number) => void
}
