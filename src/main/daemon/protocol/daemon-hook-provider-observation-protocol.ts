import type {
  HookProviderObservation,
  HookProviderObservationUpdate
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'

export type RecordHookProviderObservationRequest = {
  id: string
  type: 'recordHookProviderObservation'
  payload: HookProviderObservationUpdate
}

export type RecordHookProviderObservationResult = {
  observation: HookProviderObservation
}
