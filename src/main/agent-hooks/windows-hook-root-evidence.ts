import type { Socket } from 'node:net'
import type {
  HookPaneProcessIo,
  HookRootEvidenceReader,
  HookTransportPeer
} from '../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-status/process/agent-process-recognition'
import {
  readCodexCommandMode,
  shouldUseRendererBackedCodexTerminal
} from '../../shared/agent-status/process/codex-command-classification'
import { tokenizeCommandLine } from '../../shared/agent-status/process/agent-command-line-entrypoint'
import {
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'
import {
  readWindowsLoopbackTcpPeer,
  readWindowsProcessCreationKey,
  windowsProcessBirthMilliseconds
} from '../windows/windows-hook-peer'

export function captureWindowsHookTransportPeer(socket: Socket): HookTransportPeer | undefined {
  if (
    process.platform !== 'win32' ||
    socket.remoteAddress !== '127.0.0.1' ||
    socket.localAddress !== '127.0.0.1' ||
    !socket.localPort ||
    !socket.remotePort
  ) {
    return undefined
  }
  const peer = readWindowsLoopbackTcpPeer(socket.localPort, socket.remotePort)
  return peer
    ? {
        ...peer,
        isCurrent: () =>
          !socket.destroyed && readWindowsProcessCreationKey(peer.pid) === peer.creationTimeKey
      }
    : undefined
}

function localCodexHooks(command: string): boolean {
  const words = tokenizeCommandLine(command)
  const end = words.indexOf('--')
  if (
    words
      .slice(0, end === -1 ? undefined : end)
      .some((word) => word === '--remote' || word.startsWith('--remote='))
  ) {
    return false
  }
  const mode = readCodexCommandMode(command)
  if (mode !== undefined) {
    if (mode?.startsWith('-') || ['login', 'cloud', 'agents', 'queue'].includes(mode ?? '')) {
      return false
    }
    return (
      ['exec', 'e', 'review'].includes(mode ?? '') || shouldUseRendererBackedCodexTerminal(command)
    )
  }
  const script = words.findIndex(
    (word, index) => index > 0 && /(?:^|[\\/])codex\.(?:mjs|cjs|js)$/i.test(word)
  )
  return (
    script > 0 &&
    localCodexHooks(
      `codex ${words
        .slice(script + 1)
        .map((word) => JSON.stringify(word))
        .join(' ')}`
    )
  )
}

/** A native provider may have one adjacent Node CLI shim, never another agent job. */
function isProviderWrapper(
  parent: WindowsProcessRow,
  child: WindowsProcessRow,
  provider: string
): boolean {
  const words = tokenizeCommandLine(parent.command)
  return (
    child.ppid === parent.pid &&
    /(?:^|[\\/])node(?:\.exe)?$/i.test(words[0] ?? '') &&
    words.some(
      (word, index) =>
        index > 0 &&
        (provider === 'codex'
          ? /(?:^|[\\/])codex\.(?:js|mjs|cjs)$/i.test(word)
          : /(?:^|[\\/])@anthropic-ai[\\/]claude-code[\\/].*\.(?:js|mjs|cjs)$/i.test(word))
    ) &&
    /\.exe(?:\s|$)/i.test(child.command)
  )
}

export function createWindowsHookRootEvidenceReader(
  resolveRoot: HookPaneProcessIo['resolveRoot'],
  readTable: () => Promise<WindowsProcessRow[]> = readWindowsProcessTableFresh,
  readBirthKey: (pid: number) => string | null = readWindowsProcessCreationKey
): HookRootEvidenceReader {
  return async (request) => {
    const peer = request.peer
    if (!peer || request.signal?.aborted || !peer.isCurrent()) {
      return { verdict: 'unknown' }
    }
    const root = await resolveRoot(request.paneKey, request.worktreeId)
    if (!root || root === 'legacy' || !root.creationTimeKey || request.signal?.aborted) {
      return { verdict: 'unknown' }
    }
    const rows = await readTable()
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const keys = new Map<number, string>()
    const seen = new Set<number>()
    let pid = peer.pid
    let childBirth: bigint | undefined
    let agent: WindowsProcessRow | undefined
    let reachedRoot = false
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(pid) || request.signal?.aborted) {
        return { verdict: 'unknown' }
      }
      seen.add(pid)
      const row = byPid.get(pid)
      const key = readBirthKey(pid)
      if (
        !row ||
        !key ||
        windowsProcessBirthMilliseconds(key) !== row.creationTimeMs ||
        (pid === peer.pid && key !== peer.creationTimeKey)
      ) {
        return { verdict: 'unknown' }
      }
      const birth = BigInt(key)
      if (childBirth !== undefined && birth > childBirth) {
        return { verdict: 'unknown' }
      }
      keys.set(pid, key)
      childBirth = birth
      const observed = recognizeAgentProcessFromCommandLine(row.command, {
        includeHeadlessOneShot: true
      })
      if (observed) {
        const provider = observed.agent === 'claude-agent-teams' ? 'claude' : observed.agent
        if (provider !== request.agent || (provider === 'codex' && !localCodexHooks(row.command))) {
          return { verdict: 'nested' }
        }
        if (!agent) {
          agent = row
        } else if (!isProviderWrapper(row, agent, provider)) {
          return { verdict: 'nested' }
        }
      }
      if (pid === root.pid) {
        if (key !== root.creationTimeKey) {
          return { verdict: 'unknown' }
        }
        reachedRoot = true
        break
      }
      pid = row.ppid
    }
    if (!reachedRoot || !agent || !peer.isCurrent()) {
      return { verdict: 'unknown' }
    }
    const currentRoot = await resolveRoot(request.paneKey, request.worktreeId)
    if (
      !currentRoot ||
      currentRoot === 'legacy' ||
      currentRoot.pid !== root.pid ||
      currentRoot.incarnation !== root.incarnation ||
      currentRoot.creationTimeKey !== root.creationTimeKey ||
      request.signal?.aborted ||
      !peer.isCurrent()
    ) {
      return { verdict: 'unknown' }
    }
    for (const [observedPid, key] of keys) {
      if (readBirthKey(observedPid) !== key) {
        return { verdict: 'unknown' }
      }
    }
    return {
      verdict: 'root',
      binding: root.incarnation,
      process: { pid: agent.pid, platform: 'win32', startTime: `win32:${agent.creationTimeMs}` }
    }
  }
}
