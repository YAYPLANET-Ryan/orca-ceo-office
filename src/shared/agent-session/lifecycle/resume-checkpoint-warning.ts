export const RESUME_CHECKPOINT_WARNING =
  'The terminal is running, but its resume identity could not be saved. Verify the original conversation before restarting.'

export function resumeCheckpointWarning(
  existing: string | undefined,
  checkpointFailed: boolean | undefined
): { warning?: string } {
  const warning = [existing, checkpointFailed ? RESUME_CHECKPOINT_WARNING : null]
    .filter(Boolean)
    .join('\n')
  return warning ? { warning } : {}
}
