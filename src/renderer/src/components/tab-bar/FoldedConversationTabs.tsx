import { Button } from '@/components/ui/button'
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
  items: TabBarItem[]
  showAll: boolean
  onShowAll: (value: boolean) => void
  onActivate: (id: string) => void
}
export function FoldedConversationTabs({
  items,
  showAll,
  onShowAll,
  onActivate
}: Props): React.JSX.Element | null {
  if (items.length === 0) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="my-auto shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {translate('sessionRecovery.savedTabs', 'Saved conversations')} ({items.length})
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
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
  )
}
