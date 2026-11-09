import type { AgentHookServer } from './server'
import {
  createLocalHookPaneRootResolver,
  createLocalPtyInventoryReader,
  type LocalPtyInventoryReader
} from './local-tmux-managed-pty'
import { createLocalHookRootEvidenceReader } from '../../shared/agent-hook-listener/presence/hook-process-root-evidence-reader'
import { getPtyIdForPaneKey } from '../ipc/pty/pane/key-state'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { createLocalHookContextSnapshotReader } from './local-hook-context-snapshot'
import { createWindowsHookRootEvidenceReader } from './windows-hook-root-evidence'
import { createWindowsAgentProcessObservationReader } from './windows-agent-process-observation'
import { setWindowsAgentProcessObservationReader } from '../../shared/agent-status/process/agent-process-presence-probe'
import { getWindowsProcessMetadataQueries } from '../windows/windows-process-table'

/** Hooks posted on this host name panes its own provider owns; their roots come from that
 *  provider's inventory, read lazily because daemon swaps replace the provider. */
export function installLocalHookRootEvidence(server: AgentHookServer): LocalPtyInventoryReader {
  server.setContextVerificationCapabilityReader(() => {
    if (process.platform !== 'win32') {
      return true
    }
    const native = getWindowsProcessMetadataQueries()
    return (
      typeof native?.getLoopbackTcpPeer === 'function' &&
      typeof native?.getProcessCreationTimeKey === 'function'
    )
  })
  const readInventory = createLocalPtyInventoryReader({
    getPtyId: getPtyIdForPaneKey,
    listProcesses: () => getLocalPtyProvider().listProcesses()
  })
  server.setHookContextSnapshotReader(
    createLocalHookContextSnapshotReader(readInventory, undefined, () => server.contextOwnerId)
  )
  const root = createLocalHookPaneRootResolver(readInventory)
  if (process.platform === 'win32') {
    setWindowsAgentProcessObservationReader(createWindowsAgentProcessObservationReader())
  }
  server.setHookRootEvidenceReader(
    process.platform === 'win32'
      ? createWindowsHookRootEvidenceReader(root)
      : createLocalHookRootEvidenceReader(root)
  )
  return readInventory
}
