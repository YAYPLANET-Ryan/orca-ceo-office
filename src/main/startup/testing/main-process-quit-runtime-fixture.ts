import { vi } from 'vitest'

export const createQuitRuntimeFixture = (
  flushPaneGrids: () => Promise<void> | null,
  closeNotificationDismissals: () => Promise<void> = async () => {}
) => ({
  getOffscreenBrowserBackend: () => null,
  getAgentBrowserBridge: () => null,
  getEmulatorBridge: () => null,
  disposeSkillUploadSessions: vi.fn(async () => {}),
  getRuntimeId: () => undefined,
  closeNotificationDismissals,
  flushPaneGrids
})
