export type StoredResult = {
  id: string;
  sourceKey?: string;
  filename: string;
  mime: string;
  width: number;
  height: number;
  dataUrl: string;
  cropBox: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  confidence: number;
  createdAt: number;
  expiresAt: number;
};

const DB_NAME = "pictureCut-tool";
const STORE_NAME = "results";
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("expiresAt", "expiresAt");
        store.createIndex("createdAt", "createdAt");
        store.createIndex("sourceKey", "sourceKey");
      } else {
        const store = request.transaction?.objectStore(STORE_NAME);
        if (store && !store.indexNames.contains("sourceKey")) {
          store.createIndex("sourceKey", "sourceKey");
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function addStoredResult(result: StoredResult) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    if (result.sourceKey && store.indexNames.contains("sourceKey")) {
      const request = store.index("sourceKey").openCursor(IDBKeyRange.only(result.sourceKey));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          store.put(result);
        }
      };
      request.onerror = () => reject(request.error);
    } else {
      store.put(result);
    }

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getStoredResults(): Promise<StoredResult[]> {
  const db = await openDb();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => {
      const results = (request.result as StoredResult[])
        .filter((item) => item.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

export async function deleteStoredResult(id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function clearExpiredResults() {
  const db = await openDb();
  const now = Date.now();

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.index("expiresAt").openCursor(IDBKeyRange.upperBound(now));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
