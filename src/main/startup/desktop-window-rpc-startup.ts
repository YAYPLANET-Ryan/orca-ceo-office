export async function startDesktopWindowAndRpc<TWindow>(options: {
  openWindow: () => TWindow
  startRpc: () => Promise<void>
  onRpcError?: (error: unknown) => void
}): Promise<{
  window: TWindow
  rpc: { ok: true } | { ok: false; error: unknown }
}> {
  // Why: a synchronous window exception must not prevent scheduling the command transport.
  const [window, rpc] = await Promise.allSettled([
    Promise.resolve().then(options.openWindow),
    Promise.resolve().then(options.startRpc)
  ])
  if (rpc.status === 'rejected') {
    options.onRpcError?.(rpc.reason)
  }
  if (window.status === 'rejected') {
    throw window.reason
  }
  return {
    window: window.value,
    rpc: rpc.status === 'fulfilled' ? { ok: true } : { ok: false, error: rpc.reason }
  }
}
