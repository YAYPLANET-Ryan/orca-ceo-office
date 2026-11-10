import { defineMethod } from '../../core'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'

export const DIAGNOSTICS_METHODS = [
  defineMethod({
    name: 'diagnostics.contextIntegrity',
    permission: 'workspace',
    params: null,
    handler: () => agentHookServer.getContextIntegritySummary()
  }),
  defineMethod({
    name: 'diagnostics.memory',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => {
      return await runtime.getMemorySnapshot()
    }
  })
]
