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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
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
  if (!isRecord(value)) {
    return null
  }
  const item = value
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
  if (!isRecord(value)) {
    return null
  }
  const root = value
  if (root.version !== 1 || typeof root.title !== 'string' || !Array.isArray(root.groups)) {
    return null
  }
  const groups: CeoOfficeManifestGroup[] = []
  for (const rawGroup of root.groups) {
    if (!isRecord(rawGroup)) {
      return null
    }
    const group = rawGroup
    if (
      typeof group.id !== 'string' ||
      typeof group.label !== 'string' ||
      !Array.isArray(group.items)
    ) {
      return null
    }
    const items: CeoOfficeManifestItem[] = []
    for (const rawItem of group.items) {
      const item = parseItem(rawItem)
      if (item === null) {
        return null
      }
      items.push(item)
    }
    groups.push({ id: group.id, label: group.label, items })
  }
  return { version: 1, title: root.title, groups }
}
