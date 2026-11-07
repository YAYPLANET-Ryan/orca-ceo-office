import { DaemonProtocolError } from '../../protocol/daemon-errors'

export class DaemonHelloClosedError extends DaemonProtocolError {
  constructor() {
    super('Connection closed before hello response')
    this.name = 'DaemonHelloClosedError'
  }
}
