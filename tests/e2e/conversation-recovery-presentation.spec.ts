import { test, expect } from './helpers/orca-app'
import { focusActiveTerminalInput, waitForPaneIdentitySnapshot } from './helpers/terminal'

test('a missing recovery pane remains accessible without launching another agent', async ({
  orcaPage
}) => {
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    await store.getState().updateSettings({ uiLanguage: 'ko' })
    const state = store.getState()
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        ...state.sleepingAgentSessionsByPaneKey,
        'missing-source:leaf': {
          paneKey: 'missing-source:leaf',
          tabId: 'missing-source',
          worktreeId: state.activeWorktreeId!,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'orphan-fixture-do-not-launch' },
          prompt: 'Preserved orphan request',
          state: 'working',
          capturedAt: Date.now(),
          updatedAt: Date.now(),
          origin: 'quit',
          requiresManualResume: true,
          resumeTargetPaneKey: 'missing-target:leaf'
        }
      }
    })
  })
  const before = await orcaPage.evaluate(
    () => Object.values(window.__store!.getState().tabsByWorktree).flat().length
  )
  await orcaPage.getByRole('button', { name: /저장된 대화/ }).click()
  await orcaPage.getByRole('menuitem', { name: /복원 확인 필요/ }).click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog).toContainText('Preserved orphan request')
  await expect(dialog).toContainText('orphan-fixture-do-not-launch')
  await expect(dialog).toContainText('이전 실행 상태를 확인')
  expect(
    await orcaPage.evaluate(
      () => Object.values(window.__store!.getState().tabsByWorktree).flat().length
    )
  ).toBe(before)
})

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
