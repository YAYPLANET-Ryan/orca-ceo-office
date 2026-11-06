import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { SessionRestoredBanner } from './SessionRestoredBanner'
import { PaneConversationRecovery } from './PaneConversationRecovery'
import type {
  SessionRestoredBannerPane,
  SessionRestoredBannerPaneReasons,
  SessionRestoredBannerReason
} from './session-restored-banner-pane-state'

type SessionRestoredBannerPortalsProps = {
  panes: readonly SessionRestoredBannerPane[]
  paneIds: SessionRestoredBannerPaneReasons
  tabId?: string
}

function RecoveryChrome({
  paneKey,
  reason
}: {
  paneKey: string
  reason?: SessionRestoredBannerReason
}): React.JSX.Element {
  const foreground = useAppStore((s) => s.paneForegroundAgentByPaneKey[paneKey])
  const visible =
    Boolean(reason) &&
    !(reason === 'resume-required' && foreground?.agent && !foreground.shellForeground)
  return (
    <>
      <SessionRestoredBanner visible={visible} reason={reason} />
      <PaneConversationRecovery paneKey={paneKey} />
    </>
  )
}

export function SessionRestoredBannerPortals({
  panes,
  paneIds,
  tabId
}: SessionRestoredBannerPortalsProps): React.JSX.Element {
  return (
    <>
      {panes.map((pane) => {
        const reason = paneIds.get(pane.id)
        if (!reason && !(tabId && pane.leafId)) {
          return null
        }
        return createPortal(
          // Why: resumed TUIs repaint xterm immediately, so the wake marker
          // must live in that pane's chrome instead of the PTY byte stream.
          tabId && pane.leafId ? (
            <RecoveryChrome paneKey={`${tabId}:${pane.leafId}`} reason={reason} />
          ) : (
            <SessionRestoredBanner visible={Boolean(reason)} reason={reason} />
          ),
          pane.container,
          `session-restored-banner-${pane.id}`
        )
      })}
    </>
  )
}
