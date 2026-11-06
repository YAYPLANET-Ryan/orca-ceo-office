import type { Page, TestInfo } from '@stablyai/playwright-test'

const EXIT_EVIDENCE_PREFIX = 'ORCA_E2E_RECOVERY_EXIT:'

/** Observe only the named pane in this hermetic restart fixture. */
export async function watchRestartExitEvidence(page: Page, paneKey: string): Promise<string[]> {
  const events: string[] = []
  page.on('console', (message) => {
    if (message.text().startsWith(EXIT_EVIDENCE_PREFIX) && events.length < 32) {
      events.push(message.text().slice(EXIT_EVIDENCE_PREFIX.length))
    }
  })
  await page.evaluate(
    ({ paneKey, prefix }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Hermetic restart store unavailable')
      }
      const original = store.getState().markSleepingAgentSessionExited
      store.setState({
        markSleepingAgentSessionExited: (target) => {
          if (target === paneKey) {
            const state = store.getState()
            const record = state.sleepingAgentSessionsByPaneKey[target]
            console.info(
              prefix +
                JSON.stringify({
                  observedAt: Date.now(),
                  state: state.agentStatusByPaneKey[target]?.state,
                  requiresManualResume: record?.requiresManualResume,
                  origin: record?.origin,
                  stack: new Error('hermetic exit observation').stack
                })
            )
          }
          original(target)
        }
      })
    },
    { paneKey, prefix: EXIT_EVIDENCE_PREFIX }
  )
  return events
}

export async function attachRestartTerminalEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string
): Promise<void> {
  const evidence = await page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : undefined
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    const buffer = pane?.terminal.buffer.active
    const rows = buffer
      ? Array.from({ length: Math.min(buffer.length, 200) }, (_, index) => {
          const row = buffer.getLine(Math.max(0, buffer.length - 200) + index)
          return { wrapped: row?.isWrapped ?? false, text: row?.translateToString(true) ?? '' }
        })
      : []
    return {
      tabId,
      paneId: pane?.id,
      ptyId: pane?.container?.dataset?.ptyId,
      cols: pane?.terminal.cols,
      rows: pane?.terminal.rows,
      bufferLength: buffer?.length,
      serialized: pane?.serializeAddon?.serialize?.().slice(-20_000) ?? '',
      logicalText: rows
        .map((row, index) => (index > 0 && !row.wrapped ? '\n' : '') + row.text)
        .join(''),
      bufferRows: rows
    }
  })
  await testInfo.attach(label, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json'
  })
}
