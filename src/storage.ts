import { parseProject, type Project } from './types'

/**
 * Persistence layer.
 *
 * Primary path: the File System Access API (Chrome/Edge) — the user connects a
 * local folder (like vscode.dev) and projects are saved/loaded as JSON files in
 * that folder. The directory handle is remembered in IndexedDB so a reload can
 * reconnect with a single permission prompt.
 *
 * Fallback path (Firefox/Safari): classic file download / file-input upload.
 */

export const supportsFileSystemAccess =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window

type DirHandle = FileSystemDirectoryHandle

// ---- IndexedDB persistence of the directory handle -------------------------

const DB_NAME = 'rehearsal-planner'
const STORE = 'handles'
const BACKUP_STORE = 'backups'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(BACKUP_STORE)) db.createObjectStore(BACKUP_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: unknown, store: string = STORE): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet<T>(key: string, store: string = STORE): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}


// ---- Folder connection -----------------------------------------------------

export async function connectFolder(): Promise<DirHandle> {
  const handle = await (window as unknown as {
    showDirectoryPicker: (opts?: { mode?: string }) => Promise<DirHandle>
  }).showDirectoryPicker({ mode: 'readwrite' })
  await idbSet('folder', handle)
  return handle
}

/** Try to restore the previously connected folder (may prompt for permission). */
export async function restoreFolder(): Promise<DirHandle | null> {
  try {
    const handle = await idbGet<DirHandle>('folder')
    if (!handle) return null
    const perm = await (handle as unknown as {
      queryPermission: (o: { mode: string }) => Promise<PermissionState>
    }).queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') return handle
    const req = await (handle as unknown as {
      requestPermission: (o: { mode: string }) => Promise<PermissionState>
    }).requestPermission({ mode: 'readwrite' })
    return req === 'granted' ? handle : null
  } catch {
    return null
  }
}

function fileNameFor(project: Project): string {
  const safe = project.name.replace(/[^\w\- ]+/g, '_').trim() || 'project'
  return `${safe}.rehearsal.json`
}

export async function saveProjectToFolder(dir: DirHandle, project: Project): Promise<string> {
  const name = fileNameFor(project)
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(project, null, 2))
  await writable.close()
  return name
}

export async function listProjectFiles(dir: DirHandle): Promise<string[]> {
  const names: string[] = []
  const iter = (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()
  for await (const entry of iter) {
    if (entry.kind === 'file' && entry.name.endsWith('.json')) names.push(entry.name)
  }
  return names.sort()
}

export async function loadProjectFromFolder(dir: DirHandle, name: string): Promise<Project> {
  const fileHandle = await dir.getFileHandle(name)
  const file = await fileHandle.getFile()
  return parseProject(JSON.parse(await file.text()))
}

// ---- Fallbacks (all browsers) ----------------------------------------------

export function downloadProject(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileNameFor(project)
  a.click()
  URL.revokeObjectURL(url)
}

export function uploadProject(): Promise<Project> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return reject(new Error('No file selected'))
      try {
        resolve(parseProject(JSON.parse(await file.text())))
      } catch (e) {
        reject(e)
      }
    }
    input.click()
  })
}

// ---- Working-copy autosave (localStorage + IndexedDB mirror) ---------------
//
// iOS Safari purges site storage under storage pressure or after ~7 days
// without a visit, which showed up as "the project is suddenly empty". The
// working copy therefore lives in BOTH localStorage and IndexedDB: when
// localStorage comes up empty at startup, the app silently restores the
// project from the IndexedDB mirror. Exported project files remain the only
// guaranteed persistence, so the UI flags unsaved changes.

const LS_KEY = 'rehearsal-planner.current'
const MIRROR_CURRENT = '@current'

/** Ask the browser to exempt this origin's storage from automatic eviction. */
export function requestPersistentStorage(): void {
  try {
    navigator.storage?.persist?.().catch(() => {})
  } catch {
    // not supported — best effort only
  }
}

let mirrorTimer: number | undefined

export function autosave(project: Project): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(project))
  } catch {
    // quota exceeded / private mode — localStorage copy is best-effort
  }
  clearTimeout(mirrorTimer)
  mirrorTimer = window.setTimeout(() => {
    idbSet(MIRROR_CURRENT, project, BACKUP_STORE).catch(() => {})
  }, 800)
}

export function loadAutosave(): Project | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? parseProject(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/** Fallback when localStorage was purged: the IndexedDB copy of the working project. */
export async function loadMirror(): Promise<Project | null> {
  try {
    const stored = await idbGet<unknown>(MIRROR_CURRENT, BACKUP_STORE)
    return stored ? parseProject(stored) : null
  } catch {
    return null
  }
}
