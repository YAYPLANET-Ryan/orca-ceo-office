import { chromium, expect } from '@stablyai/playwright-test'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9335', { timeout: 30000 })
try {
  await expect
    .poll(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url().startsWith('file:')),
      { timeout: 30000 }
    )
    .toBeTruthy()
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('file:'))
  if (!page) {
    throw new Error('Installed Orca renderer target is missing')
  }
  await page.waitForFunction(
    () =>
      document.readyState === 'complete' &&
      Boolean(window.api) &&
      Boolean(document.getElementById('root')?.firstElementChild),
    undefined,
    { timeout: 30000 }
  )
  console.log('Installed hidden Orca renderer responded with its preload bridge ready')
} finally {
  await browser.close()
}
