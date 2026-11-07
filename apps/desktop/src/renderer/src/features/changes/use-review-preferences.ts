import { useEffect, useMemo, useState } from 'react'
import { sourceControlSchemas } from '@ari/contracts/rpc'
import type { GitComparison, GitReviewFile, GitReviewManifest } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ui:review-preferences')
const maxViewed = 5000
interface ViewedFile {
  scopeId: string
  path: string
  contentId: string | null
}
interface Preferences {
  comparison: GitComparison
  path: string | null
  filter: string
  scroll: Record<string, number>
  viewed: ViewedFile[]
}
const defaults = (): Preferences => ({
  comparison: { kind: 'working-tree' },
  path: null,
  filter: '',
  scroll: {},
  viewed: [],
})
function reviewIdentity(manifest: GitReviewManifest, file: GitReviewFile): ViewedFile {
  if (manifest.reviewScopeId && file.contentId)
    return { scopeId: manifest.reviewScopeId, path: file.path, contentId: file.contentId }
  return {
    scopeId: manifest.id,
    path: file.path,
    contentId: null,
  }
}
function load(key: string): Preferences {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return defaults()
    const value = raw as Record<string, unknown>
    const comparison = sourceControlSchemas.comparison.safeParse(value['comparison'])
    const path = sourceControlSchemas.path.safeParse(value['path'])
    const scroll =
      typeof value['scroll'] === 'object' && value['scroll'] !== null
        ? (Object.fromEntries(
            Object.entries(value['scroll'])
              .slice(-100)
              .filter(
                ([path, offset]) =>
                  sourceControlSchemas.path.safeParse(path).success &&
                  typeof offset === 'number' &&
                  Number.isFinite(offset) &&
                  offset >= 0,
              ),
          ) as Record<string, number>)
        : {}
    return {
      comparison: comparison.success ? comparison.data : { kind: 'working-tree' },
      path: path.success ? path.data : null,
      filter: typeof value['filter'] === 'string' ? value['filter'].slice(0, 256) : '',
      scroll,
      viewed: Array.isArray(value['viewed'])
        ? value['viewed'].slice(-maxViewed).flatMap((entry: unknown) => {
            if (typeof entry !== 'object' || entry === null) return []
            const record = entry as Record<string, unknown>
            const scopeId = sourceControlSchemas.oid.safeParse(record['scopeId'])
            const path = sourceControlSchemas.path.safeParse(record['path'])
            const contentId = sourceControlSchemas.oid.safeParse(record['contentId'])
            return scopeId.success && path.success && contentId.success
              ? [{ scopeId: scopeId.data, path: path.data, contentId: contentId.data }]
              : []
          })
        : [],
    }
  } catch (error) {
    log.warn('Review preferences unavailable', { error: String(error) })
    return defaults()
  }
}

/** Retains review preferences and explicit progress without rerendering on every scroll frame. */
export function useReviewPreferences(scopeKey: string) {
  const [, render] = useState(0)
  const store = useMemo(() => {
    const key = `ari:review:${scopeKey}`
    const value = load(key)
    return {
      key,
      value,
      positions: new Map(Object.entries(value.scroll)),
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  }, [scopeKey])
  const persist = (): void => {
    try {
      sessionStorage.setItem(
        store.key,
        JSON.stringify({
          ...store.value,
          scroll: Object.fromEntries(store.positions),
          viewed: store.value.viewed.filter((entry) => entry.contentId !== null),
        }),
      )
    } catch (error) {
      log.warn('Review preferences could not be saved', { error: String(error) })
    }
  }
  useEffect(() => {
    persist()
  }, [store, store.value])
  useEffect(
    () => () => {
      clearTimeout(store.timer)
      persist()
    },
    [store],
  )
  return {
    value: store.value,
    change: (patch: Partial<Omit<Preferences, 'scroll' | 'viewed'>>) => {
      store.value = { ...store.value, ...patch }
      render((value) => value + 1)
    },
    offset: (path: string) => store.positions.get(path) ?? 0,
    viewedPaths: (manifest: GitReviewManifest | null) => {
      const paths = new Set<string>()
      if (!manifest) return paths
      const identities = new Map(
        store.value.viewed.map((entry) => [
          JSON.stringify([entry.scopeId, entry.path]),
          entry.contentId,
        ]),
      )
      for (const file of manifest.files) {
        const identity = reviewIdentity(manifest, file)
        if (
          identities.get(JSON.stringify([identity.scopeId, identity.path])) === identity.contentId
        )
          paths.add(file.path)
      }
      return paths
    },
    markViewed: (manifest: GitReviewManifest, file: GitReviewFile, checked: boolean) => {
      const identity = reviewIdentity(manifest, file)
      const viewed = store.value.viewed.filter(
        (entry) => entry.scopeId !== identity.scopeId || entry.path !== identity.path,
      )
      if (checked) viewed.push(identity)
      store.value = { ...store.value, viewed: viewed.slice(-maxViewed) }
      render((value) => value + 1)
    },
    reconcileViewed: (manifest: GitReviewManifest) => {
      const identities = new Map(
        manifest.files.map((file) => [file.path, reviewIdentity(manifest, file)]),
      )
      const scopeId = manifest.reviewScopeId ?? manifest.id
      const viewed = store.value.viewed.filter(
        (entry) =>
          entry.scopeId !== scopeId || identities.get(entry.path)?.contentId === entry.contentId,
      )
      if (viewed.length === store.value.viewed.length) return
      store.value = { ...store.value, viewed }
      render((value) => value + 1)
    },
    recordScroll: (path: string, offset: number) => {
      store.positions.delete(path)
      store.positions.set(path, offset)
      if (store.positions.size > 100) store.positions.delete(store.positions.keys().next().value!)
      clearTimeout(store.timer)
      store.timer = setTimeout(persist, 200)
    },
  }
}
