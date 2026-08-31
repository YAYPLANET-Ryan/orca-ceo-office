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
import { resolveCeoOfficeNavigation } from './ceo-office-navigation'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { ceoOfficeManifestRootCandidates, isFolderAlreadyRegistered } from './ceo-office-roots'

const MANIFEST_PATH = '.orca/ceo-office.json'

const GROUP_ICONS = [BriefcaseBusiness, CircleUserRound, FolderKanban, ShieldCheck]

// Keep the CEO navigation visible while a remote manifest is loading. The manifest
// on the workspace root stays the source of truth and replaces this once read.
//
// This has to mirror .orca/ceo-office.json. When it drifts there is no symptom to
// notice: a client that cannot read the manifest shows this list instead, and it
// simply looks like a shorter catalog. A paired laptop displayed six businesses
// against the runtime's seven, and the only way to tell was to compare by hand.
// If you edit one, edit the other.
const DEFAULT_MANIFEST: CeoOfficeManifest = {
  version: 1,
  title: 'CEO Office',
  groups: [
    {
      id: 'businesses',
      label: 'Businesses',
      items: [
        { id: 'ceo-office', label: 'CEO Office', path: '01_CEO_OFFICE', kind: 'folder' },
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
      items: [
        { id: 'personal-root', label: 'Personal Office', path: '02_PERSONAL', kind: 'folder' }
      ]
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
  const globalSettings = useAppStore((s) => s.settings)
  const activeWorktree = useActiveWorktree()
  // Which host owns the active workspace. A paired client leaves
  // settings.activeRuntimeEnvironmentId null while working entirely against a
  // remote runtime, so reading the global value sent every manifest read to the
  // local disk — where E:/ORCA does not exist and fs:readFile answers "path
  // resolves outside allowed directories". Scope to the workspace instead, the
  // same way the editor and diff viewer do.
  const runtimeEnvironmentId = useAppStore((s) => {
    const hostId = getResolvedExecutionHostIdForWorktree(s, activeWorktree?.id)
    const parsed = parseExecutionHostId(hostId)
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  })
  const settings = React.useMemo(
    () => settingsForRuntimeOwner(globalSettings, runtimeEnvironmentId) ?? globalSettings,
    [globalSettings, runtimeEnvironmentId]
  )
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
  const activePtyId = useAppStore((s) =>
    s.activeTabId ? s.ptyIdsByTabId[s.activeTabId]?.[0] : undefined
  )
  const createTab = useAppStore((s) => s.createTab)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)
  const repoPaths = useAppStore((s) => s.repos.map((repo) => repo.path).join('\n'))
  const [manifest, setManifest] = React.useState<CeoOfficeManifest | null>(DEFAULT_MANIFEST)
  // The root the manifest was actually found under. Entry paths resolve against
  // this, not the active workspace — see ceo-office-roots.ts.
  const [manifestRoot, setManifestRoot] = React.useState<string | undefined>(undefined)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    let canceled = false
    if (!activeWorktree) {
      setManifest(null)
      return () => {
        canceled = true
      }
    }
    // Only fall back to the built-in list before the first successful read. This
    // effect re-runs whenever a project is registered, and resetting here made the
    // catalog flick to the built-in list — which is missing whatever the real
    // manifest has gained — on every click.
    setManifest((current) => current ?? DEFAULT_MANIFEST)
    const state = useAppStore.getState()
    const candidates = ceoOfficeManifestRootCandidates({
      activeWorktreeId: activeWorktree.id,
      activeRoot: workspaceRoot ?? activeWorktree.path,
      worktrees: Object.values(state.worktreesByRepo)
        .flat()
        .map((worktree) => ({ id: worktree.id, path: worktree.path }))
    })
    void (async () => {
      // Why collected rather than ignored: falling back to the built-in list looks
      // identical whether the manifest is genuinely absent or the read failed, and
      // the built-in list drifts from the real one. A paired client showed six
      // businesses while the manifest on the runtime had seven, with nothing
      // anywhere saying a read had failed.
      const attempts: string[] = []
      for (const candidate of candidates) {
        if (canceled) {
          return
        }
        try {
          const { content } = await readRuntimeFileContent({
            settings,
            filePath: joinPath(candidate.root, MANIFEST_PATH),
            relativePath: MANIFEST_PATH,
            // Addresses the read on a remote runtime; the absolute path above is
            // only used for a local read.
            worktreeId: candidate.worktreeId,
            connectionId,
            expectedExternalSshTargetId: connectionId
          })
          const parsed = parseCeoOfficeManifest(JSON.parse(content))
          if (canceled) {
            return
          }
          setManifest(parsed)
          setManifestRoot(candidate.root)
          return
        } catch (err) {
          attempts.push(
            `${candidate.root} (${candidate.worktreeId}): ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      if (!canceled) {
        // Absent from every candidate is the ordinary case for a workspace that is
        // not the ORCA root, so this is a warning rather than an error — but it has
        // to be visible, because the fallback silently substitutes a stale catalog.
        console.warn(
          `[ceo-office] no readable ${MANIFEST_PATH}; showing the built-in catalog. Tried:\n${attempts.join('\n')}`
        )
      }
    })()
    return () => {
      canceled = true
    }
  }, [activeWorktree, connectionId, settings, workspaceRoot, repoPaths])

  if (!manifest || !activeWorktree) {
    return null
  }
  const openManifestItem = async (item: CeoOfficeManifest['groups'][number]['items'][number]) => {
    const action = resolveCeoOfficeNavigation({
      itemPath: joinPath(manifestRoot ?? workspaceRoot ?? activeWorktree.path, item.path),
      itemKind: item.kind,
      connectionId,
      activePtyId
    })
    if (action.kind === 'none') {
      return
    }
    if (action.kind === 'ssh-cd') {
      window.api.pty.write(action.ptyId, action.command)
      return
    }
    const alreadyRegistered = isFolderAlreadyRegistered({
      folderPath: action.folderPath,
      repoPaths: useAppStore.getState().repos.map((repo) => repo.path)
    })
    // Registers on first click and reuses the project afterwards, activating and
    // revealing its workspace either way.
    const repo = await addNonGitFolder(action.folderPath)
    if (!repo) {
      return
    }
    // A revisit gets a fresh terminal — returning to a business usually means
    // starting a second line of work beside the first. The first click does not:
    // registering the folder activates its workspace, and that already opens one.
    if (!alreadyRegistered) {
      return
    }
    // Open the terminal in the workspace the click just activated, not the
    // project's first one. A business is expected to carry several workspaces
    // (finance, planning, marketing…), and index 0 would drop every terminal into
    // whichever happened to be created first.
    const state = useAppStore.getState()
    const worktrees = state.worktreesByRepo[repo.id] ?? []
    const worktree =
      worktrees.find((candidate) => candidate.id === state.activeWorktreeId) ?? worktrees[0]
    if (worktree) {
      createTab(worktree.id, undefined, undefined, { activate: true, recordInteraction: true })
    }
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
