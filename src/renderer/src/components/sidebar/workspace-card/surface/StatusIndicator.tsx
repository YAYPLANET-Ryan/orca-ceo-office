import React from 'react'
import { Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import {
  StateIndicatorTooltip,
  type StateIndicatorTooltipSide
} from '@/components/StateIndicatorTooltip'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

export type Status = WorktreeStatus

type StatusIndicatorProps = Omit<React.ComponentProps<'span'>, 'title'> & {
  status: Status
  showTooltip?: boolean
  tooltipSide?: StateIndicatorTooltipSide
}

const AGENT_STATUS_TOOLTIP_STATUSES = new Set<Status>([
  'active',
  'working',
  'monitoring',
  'permission',
  'failed',
  'interrupted',
  'unconfirmed',
  'done'
])

const StatusIndicator = React.memo(function StatusIndicator({
  status,
  className,
  showTooltip = true,
  tooltipSide,
  ...rest
}: StatusIndicatorProps) {
  useUiLanguageRevision()
  const tooltipLabel =
    showTooltip && AGENT_STATUS_TOOLTIP_STATUSES.has(status) ? getWorktreeStatusLabel(status) : null
  const indicatorProps = { role: 'img', 'aria-label': getWorktreeStatusLabel(status), ...rest }
  let indicator: React.JSX.Element

  if (status === 'working') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <AgentWorkingSpinner className="size-2" />
      </span>
    )
  } else if (status === 'monitoring') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <Activity className="size-3 text-agent-working" aria-hidden="true" />
      </span>
    )
  } else if (status === 'failed') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <span className="block size-1.5 rounded-full bg-red-500" />
      </span>
    )
  } else if (status === 'interrupted') {
    // User-requested Stop is neutral rather than failure or completion.
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <span className="block size-1.5 rounded-full bg-muted-foreground" />
      </span>
    )
  } else if (status === 'unconfirmed') {
    // Reuse the missing-evidence glyph/tone without nesting its tooltip.
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <AgentStateDot state="unconfirmed" size="md" title={null} />
      </span>
    )
  } else if (status === 'permission') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <AgentQuestionIcon className="size-3" />
      </span>
    )
  } else if (status === 'active') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        <span className="block size-2 rounded-full border border-muted-foreground" />
      </span>
    )
  } else {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...indicatorProps}
      >
        {status === 'done' ? (
          <AgentStateDot state="done" size="md" title={null} />
        ) : (
          <span className="block size-2 rounded-full bg-muted-foreground/40" />
        )}
      </span>
    )
  }

  return (
    <StateIndicatorTooltip label={tooltipLabel} side={tooltipSide}>
      {indicator}
    </StateIndicatorTooltip>
  )
})

export default StatusIndicator
