import { Button } from '@/components/ui/button'
import { useState } from 'react'
import { useAppStore } from '@/store'
import { pendingConversationRecoveries } from '@/lib/pending-conversation-recovery'
import { layoutContainsLeaf } from '@/lib/sleeping-agent-pane-ownership'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { getTabDragLabel, type TabBarItem } from './tab-bar-item-model'

type Props = {
  worktreeId: string
  items: TabBarItem[]
  showAll: boolean
  onShowAll: (value: boolean) => void
  onActivate: (id: string) => void
}
export function FoldedConversationTabs({
  worktreeId,
  items,
  showAll,
  onShowAll,
  onActivate
}: Props): React.JSX.Element | null {
  const records = useAppStore((s) => s.sleepingAgentSessionsByPaneKey)
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId])
  const layouts = useAppStore((s) => s.terminalLayoutsByTabId)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const pending = pendingConversationRecoveries(records, worktreeId)
  const selected =
    selectedKey && records[selectedKey]?.worktreeId === worktreeId
      ? records[selectedKey]
      : undefined
  if (items.length === 0 && pending.length === 0 && !selected) {
    return null
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="my-auto shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {translate('sessionRecovery.savedTabs', 'Saved conversations')} (
            {items.length + pending.length})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {pending.map((record) => (
            <DropdownMenuItem
              key={record.paneKey}
              onSelect={() => {
                const target = record.resumeTargetPaneKey!
                const tab = tabs?.find((entry) => target.startsWith(`${entry.id}:`))
                // A tab alone is not enough: the saved destination leaf may have gone.
                const leaf = target.slice((tab?.id.length ?? 0) + 1)
                if (tab && layoutContainsLeaf(layouts[tab.id]?.root, leaf)) {
                  onActivate(tab.id)
                } else {
                  setSelectedKey(record.paneKey)
                }
              }}
            >
              {translate('sessionRecovery.pendingLabel', 'Recovery needs checking')} —{' '}
              {record.agent}
            </DropdownMenuItem>
          ))}
          {items.map((item) => (
            <DropdownMenuItem key={item.id} onSelect={() => onActivate(item.id)}>
              {getTabDragLabel(item, true)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onShowAll(!showAll)}>
            {showAll
              ? translate('sessionRecovery.fold', 'Fold ended agent tabs')
              : translate('sessionRecovery.showAll', 'Show all tabs')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedKey(null)
          }
        }}
      >
        <DialogContent>
          <DialogTitle>{translate('sessionRecovery.savedTabs', 'Saved conversations')}</DialogTitle>
          <DialogDescription>
            {translate(
              'sessionRecovery.missingTarget',
              'The recovery pane is unavailable. The saved conversation is retained. Its previous execution must be checked before starting it again.'
            )}
          </DialogDescription>
          <div className="max-h-64 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words text-sm">
            <p>
              {selected?.agent}: {selected?.providerSession.id}
            </p>
            <p>{selected?.prompt}</p>
            <p>{selected?.lastAssistantMessage}</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
