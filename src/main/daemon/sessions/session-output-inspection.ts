import { SessionProcessInspection } from './session-process-inspection'
import type { SessionOutputPlane } from './session-output-plane'

export abstract class SessionOutputInspection extends SessionProcessInspection {
  protected abstract readonly output: SessionOutputPlane

  hasAttachedClient(token: symbol): boolean {
    return this.output.snapshotClients().some((client) => client.token === token)
  }

  getPartialEscapeTailAnsi(): string {
    return this.output.getPartialEscapeTailAnsi()
  }

  getAppliedSize(): { cols: number; rows: number } | null {
    return this.output.getAppliedSize()
  }

  getCwd(): string | null {
    return this.output.getCwd()
  }
}
