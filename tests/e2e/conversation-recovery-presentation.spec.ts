import { test, expect } from './helpers/orca-app'
import { focusActiveTerminalInput, waitForPaneIdentitySnapshot } from './helpers/terminal'

test('saved conversation retains context, protects a draft and folds reversibly', async ({
  orcaPage
}) => {
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'ko' })
  })
  const identity = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const paneKey = `${identity.tabId}:${identity.panes[0].leafId}`
  await orcaPage.evaluate(
    ({ paneKey, tabId }) => {
      const store = window.__store!
      const state = store.getState()
      const worktreeId = state.activeWorktreeId!
      store.setState({
        sleepingAgentSessionsByPaneKey: {
          ...state.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            paneKey,
            tabId,
            worktreeId,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'fixture-conversation-do-not-launch' },
            prompt: 'Checkpoint request sentinel',
            lastAssistantMessage: 'Checkpoint response sentinel',
            state: 'done',
            capturedAt: Date.now(),
            updatedAt: Date.now(),
            origin: 'live',
            requiresManualResume: true
          }
        },
        paneForegroundAgentByPaneKey: {
          ...state.paneForegroundAgentByPaneKey,
          [paneKey]: { agent: null, shellForeground: true }
        }
      })
    },
    { paneKey, tabId: identity.tabId }
  )
  const recovery = orcaPage.locator('[data-conversation-recovery]')
  await expect(recovery).toBeVisible()
  await recovery.locator('summary').click()
  await expect(recovery).toContainText('Checkpoint request sentinel')
  await expect(recovery).toContainText('Checkpoint response sentinel')

  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type('DRAFT_MUST_NOT_BE_SUBMITTED')
  await recovery.getByRole('button').click()
  await expect(recovery).toContainText('터미널 입력이 변경됐습니다.')

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.createTab(state.activeWorktreeId!)
  })
  const saved = orcaPage.getByRole('button', { name: /저장된 대화/ })
  await expect(saved).toBeVisible()
  await expect(orcaPage.locator(`[data-tab-id="${identity.tabId}"]`)).toHaveCount(0)
  await saved.click()
  await orcaPage.getByRole('menuitem', { name: '모든 탭 표시' }).click()
  await expect(orcaPage.locator(`[data-tab-id="${identity.tabId}"]`)).toBeVisible()
  await orcaPage.locator(`[data-tab-id="${identity.tabId}"]`).click()
  await expect(recovery).toBeVisible()
  await expect(recovery).toContainText('Checkpoint request sentinel')
})
