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

// Keep the CEO navigation visible while an SSH-backed manifest is loading. The
// remote manifest remains the source of truth and replaces this once available.
const DEFAULT_MANIFEST: CeoOfficeManifest = {
  version: 1,
  title: 'CEO Office',
  groups: [
    {
      id: 'businesses',
      label: 'Businesses',
      items: [
        { id: 'oildealer', label: 'OilDealer', path: '02_BUSINESSES/oildealer', kind: 'folder' },
        { id: 'cubeplanet', label: 'CubePlanet', path: '02_BUSINESSES/cubeplanet', kind: 'folder' },
        { id: 'yieldcore', label: 'YieldCore', path: '02_BUSINESSES/yieldcore', kind: 'folder' },
        { id: 'gasstation', label: 'GasStation', path: '02_BUSINESSES/gasstation', kind: 'folder' },
        { id: 'compagnon', label: 'Compagnon', path: '02_BUSINESSES/compagnon', kind: 'folder' },
        { id: 'family', label: 'Family', path: '02_BUSINESSES/family', kind: 'folder' }
      ]
    },
    {
      id: 'personal',
      label: 'Personal',
      items: [{ id: 'personal-root', label: 'Personal Office', path: '02_PERSONAL', kind: 'folder' }]
    },
    {
      id: 'shared',
      label: 'Shared',
      items: [
        { id: 'shared-root', label: 'Shared Controls', path: '03_SHARED', kind: 'folder' },
        { id: 'review', label: 'Review Queue', path: '05_REVIEW', kind: 'section' },
        { id: 'approved', label: 'Approval Gates', path: '05_APPROVED', kind: 'section' }
      ]
    }
  ]
}

export default function CeoOfficeSidebar(): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)
  const activeWorktree = useActiveWorktree()
  const workspaceRoot = useAppStore((s) =>
    activeWorktree
      ? (s.repos.find((repo) => repo.id === activeWorktree.repoId)?.path ?? activeWorktree.path)
      : undefined
  )
  const connectionId = useAppStore((s) =>
    activeWorktree
      ? (s.repos.find((repo) => repo.id === activeWorktree.repoId)?.connectionId ?? undefined)
      : undefined
  )
  const [manifest, setManifest] = React.useState<CeoOfficeManifest | null>(DEFAULT_MANIFEST)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    let canceled = false
    if (!activeWorktree) {
      setManifest(null)
      return () => {
        canceled = true
      }
    }
    setManifest(DEFAULT_MANIFEST)
    void readRuntimeFileContent({
      settings,
      filePath: joinPath(workspaceRoot ?? activeWorktree.path, MANIFEST_PATH),
      relativePath: MANIFEST_PATH,
      worktreeId: activeWorktree.id,
      connectionId,
      expectedExternalSshTargetId: connectionId
    })
      .then(({ content }) => {
        if (canceled) {
          return
        }
        try {
          setManifest(parseCeoOfficeManifest(JSON.parse(content)))
        } catch {}
      })
      .catch(() => undefined)
    return () => {
      canceled = true
    }
  }, [activeWorktree, connectionId, settings, workspaceRoot])

  if (!manifest || !activeWorktree) {
    return null
  }
  const openManifestItem = async (item: CeoOfficeManifest['groups'][number]['items'][number]) => {
    const itemPath = joinPath(workspaceRoot ?? activeWorktree.path, item.path)
    // CEO Office entries are folder-backed project/session roots. Registering
    // them through Orca keeps navigation inside the app and activates the
    // resulting workspace instead of delegating to Windows Explorer.
    await addNonGitFolder(itemPath)
  }

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
                        void openManifestItem(item).catch(() => undefined)
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
