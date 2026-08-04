import React from 'react'
import {
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  FolderKanban,
  ShieldCheck
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { joinPath } from '@/lib/path'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { cn } from '@/lib/utils'
import { parseCeoOfficeManifest, type CeoOfficeManifest } from './ceo-office-manifest'

const MANIFEST_PATH = '.orca/ceo-office.json'

const GROUP_ICONS = [BriefcaseBusiness, CircleUserRound, FolderKanban, ShieldCheck]

export default function CeoOfficeSidebar(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const activeWorktree = useActiveWorktree()
  const [manifest, setManifest] = React.useState<CeoOfficeManifest | null>(null)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    let canceled = false
    if (!activeWorktree) {
      setManifest(null)
      return () => {
        canceled = true
      }
    }
    void readRuntimeFileContent({
      settings,
      filePath: joinPath(activeWorktree.path, MANIFEST_PATH),
      relativePath: MANIFEST_PATH,
      worktreeId: activeWorktree.id
    })
      .then(({ content }) => {
        if (canceled) return
        try {
          setManifest(parseCeoOfficeManifest(JSON.parse(content)))
        } catch {
          setManifest(null)
        }
      })
      .catch(() => {
        if (!canceled) setManifest(null)
      })
    return () => {
      canceled = true
    }
  }, [activeWorktree, settings])

  if (!manifest || !activeWorktree) return null
  const currentWorktree = activeWorktree

  return (
    <section
      aria-label={manifest.title}
      className="mx-2 mb-1 rounded-md border border-worktree-sidebar-border/60 bg-worktree-sidebar-foreground/[0.03] px-1.5 py-1.5"
    >
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-worktree-sidebar-foreground/45">
        {manifest.title}
      </div>
      <div className="flex flex-col gap-0.5">
        {manifest.groups.map((group, index) => {
          const isOpen = expanded[group.id] !== false
          const GroupIcon = GROUP_ICONS[index % GROUP_ICONS.length]
          return (
            <div key={group.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded((current) => ({ ...current, [group.id]: !isOpen }))}
                className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] font-medium text-worktree-sidebar-foreground/70 hover:bg-worktree-sidebar-foreground/8"
              >
                {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                <GroupIcon className="size-3.5 text-worktree-sidebar-foreground/45" />
                <span className="truncate">{group.label}</span>
              </button>
              {isOpen ? (
                <div className="ml-5 border-l border-worktree-sidebar-border/50 pl-1">
                  {group.items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      title={item.path}
                      onClick={() => {
                        void window.api.shell
                          .openPath(joinPath(currentWorktree.path, item.path))
                          .catch(() => undefined)
                      }}
                      className={cn(
                        'block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-worktree-sidebar-foreground/60',
                        'hover:bg-worktree-sidebar-foreground/8'
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}
