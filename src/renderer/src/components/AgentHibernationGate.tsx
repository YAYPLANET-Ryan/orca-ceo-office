import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  startAgentHibernationCoordinator,
  stopAgentHibernationCoordinator
} from '@/lib/agent-hibernation-coordinator'
import {
  startCompletedAgentWorkspaceRetirementCoordinator,
  stopCompletedAgentWorkspaceRetirementCoordinator
} from '@/lib/completed-agent-workspace-retirement-coordinator'

export function AgentHibernationGate(): null {
  const enabled = useAppStore((state) => state.settings?.experimentalAgentHibernation === true)
  const workspaceRetirementEnabled = useAppStore(
    (state) => state.settings?.autoArchiveCompletedAgentWorkspaces === true
  )

  useEffect(() => {
    if (!enabled) {
      stopAgentHibernationCoordinator()
      return
    }
    return startAgentHibernationCoordinator()
  }, [enabled])

  useEffect(() => {
    if (!workspaceRetirementEnabled) {
      stopCompletedAgentWorkspaceRetirementCoordinator()
      return
    }
    return startCompletedAgentWorkspaceRetirementCoordinator()
  }, [workspaceRetirementEnabled])

  return null
}
