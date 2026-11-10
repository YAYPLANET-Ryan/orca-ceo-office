import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'

export const SESSION_RESTORED_BANNER_TEXT = '--- session restored ---'
export const SESSION_RESUME_UNAVAILABLE_BANNER_TEXT =
  '--- previous session unavailable, started fresh ---'
export const SESSION_RESUME_REQUIRED_BANNER_TEXT =
  '--- agent not restarted; resume the saved conversation from the session list ---'

type SessionRestoredBannerProps = {
  visible: boolean
  reason?: SessionRestoredBannerReason
}

export function SessionRestoredBanner({
  visible,
  reason = 'restored'
}: SessionRestoredBannerProps): React.JSX.Element | null {
  if (!visible) {
    return null
  }

  return (
    <div className="session-restored-banner">
      {reason === 'resume-unavailable'
        ? SESSION_RESUME_UNAVAILABLE_BANNER_TEXT
        : reason === 'resume-required'
          ? SESSION_RESUME_REQUIRED_BANNER_TEXT
          : SESSION_RESTORED_BANNER_TEXT}
    </div>
  )
}
