import { DaemonProtocolError } from './daemon-errors'

// A closed handshake proves neither process death nor loss of its live PTYs.
export class DaemonHelloClosedError extends DaemonProtocolError {
  constructor() {
    super('Connection closed before hello response')
    this.name = 'DaemonHelloClosedError'
  }
}
