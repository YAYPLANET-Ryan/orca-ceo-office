export type CeoOfficeManifestItem = {
  id: string
  label: string
  path: string
  kind?: 'section' | 'task' | 'folder'
}

export type CeoOfficeManifestGroup = {
  id: string
  label: string
  items: CeoOfficeManifestItem[]
}

export type CeoOfficeManifest = {
  version: 1
  title: string
  groups: CeoOfficeManifestGroup[]
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  const normalized = value.replaceAll('\\', '/')
  return (
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..')
  )
}

function parseItem(value: unknown): CeoOfficeManifestItem | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    typeof item.label !== 'string' ||
    !isSafeRelativePath(item.path)
  ) {
    return null
  }
  const kind = item.kind
  return {
    id: item.id,
    label: item.label,
    path: item.path.replaceAll('\\', '/'),
    ...(kind === 'section' || kind === 'task' || kind === 'folder' ? { kind } : {})
  }
}

export function parseCeoOfficeManifest(value: unknown): CeoOfficeManifest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const root = value as Record<string, unknown>
  if (root.version !== 1 || typeof root.title !== 'string' || !Array.isArray(root.groups)) {
    return null
  }
  const groups: CeoOfficeManifestGroup[] = []
  for (const rawGroup of root.groups) {
    if (!rawGroup || typeof rawGroup !== 'object') {
      return null
    }
    const group = rawGroup as Record<string, unknown>
    if (
      typeof group.id !== 'string' ||
      typeof group.label !== 'string' ||
      !Array.isArray(group.items)
    ) {
      return null
    }
    const items = group.items.map(parseItem)
    if (items.some((item): item is null => item === null)) {
      return null
    }
    groups.push({ id: group.id, label: group.label, items: items as CeoOfficeManifestItem[] })
  }
  return { version: 1, title: root.title, groups }
}
