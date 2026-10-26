export function getCeoUpdateBlockReason(version: string): string | null {
  if (!/-ceo(?:[.+-]|$)/i.test(version)) {
    return null
  }
  return 'This CEO build requires a verified CEO installer. In-app updates are disabled to preserve its session recovery changes. Use the reviewed installer and keep the current session backup.'
}
