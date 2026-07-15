import type { AIRenderProvider, AIRenderQuality } from './aiRender';

const DB_NAME = 'open3d_ai_render_history';
const DB_VERSION = 1;
const STORE_NAME = 'renders';
const MAX_RENDERS_PER_PROJECT = 12;

export interface AIRenderHistoryEntry {
  id: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  imageDataUrl: string;
  provider: AIRenderProvider;
  model: string;
  quality: AIRenderQuality;
  style: string;
  roomLabel: string;
}

export type NewAIRenderHistoryEntry = Omit<AIRenderHistoryEntry, 'id' | 'createdAt'>;

function openHistoryDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Cannot open AI render history.'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('AI render history request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('AI render history transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('AI render history transaction was cancelled.'));
  });
}

export async function listAIRenderHistory(projectId: string): Promise<AIRenderHistoryEntry[]> {
  if (typeof indexedDB === 'undefined' || !projectId) return [];
  const db = await openHistoryDB();
  try {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const entries = await requestResult(
      transaction.objectStore(STORE_NAME).index('projectId').getAll(IDBKeyRange.only(projectId)),
    );
    return entries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_RENDERS_PER_PROJECT);
  } finally {
    db.close();
  }
}

export async function saveAIRenderHistory(entry: NewAIRenderHistoryEntry): Promise<AIRenderHistoryEntry> {
  const saved: AIRenderHistoryEntry = {
    ...entry,
    id: typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `render-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  const db = await openHistoryDB();
  try {
    let transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(saved);
    await transactionDone(transaction);

    const all = await listEntriesFromOpenDB(db, entry.projectId);
    const stale = all
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(MAX_RENDERS_PER_PROJECT);
    if (stale.length > 0) {
      transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const item of stale) store.delete(item.id);
      await transactionDone(transaction);
    }
    return saved;
  } finally {
    db.close();
  }
}

async function listEntriesFromOpenDB(db: IDBDatabase, projectId: string): Promise<AIRenderHistoryEntry[]> {
  const transaction = db.transaction(STORE_NAME, 'readonly');
  return requestResult(
    transaction.objectStore(STORE_NAME).index('projectId').getAll(IDBKeyRange.only(projectId)),
  );
}

export async function deleteAIRenderHistory(id: string): Promise<void> {
  const db = await openHistoryDB();
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}
