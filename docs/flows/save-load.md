# Save / load flow

The budget is a single `.json` file on disk. When encryption is enabled the file is an AES-256-GCM envelope; otherwise it is plain JSON. The Rust backend handles all filesystem access; the frontend never calls Node or browser file APIs directly.

## Opening an encrypted file

```mermaid
sequenceDiagram
    participant User
    participant FS as FileSetup.tsx
    participant DB as db.ts
    participant Cry as crypto.ts
    participant Tau as lib.rs

    User->>FS: app launches
    FS->>DB: getLastFilePath()
    DB->>Tau: invoke("get_last_file_path")
    Tau-->>DB: saved path or null
    DB-->>FS: path

    FS->>DB: loadFromFile(path)
    DB->>Tau: invoke("load_data", path)
    Tau-->>DB: file contents string
    DB->>Cry: isEncryptedFile(raw)
    Cry-->>DB: true

    DB-->>FS: throws "FILE_ENCRYPTED"
    FS->>FS: setPendingPath(path)
    FS->>User: render PasswordPrompt

    User->>FS: submit password
    FS->>DB: loadFromFile(path, password)
    DB->>Tau: invoke("load_data", path)
    Tau-->>DB: encrypted blob
    DB->>Cry: decryptData(blob, password)
    Cry-->>DB: JSON string
    DB->>DB: JSON.parse + merge with emptyData()
    DB->>DB: startupCleanup() migrations
    DB-->>FS: resolved
    FS->>User: onReady()
```

## Saving (every mutation)

```mermaid
sequenceDiagram
    participant Comp as Any Component
    participant DB as db.ts
    participant Cry as crypto.ts
    participant Tau as lib.rs
    participant Disk

    Comp->>DB: addTransaction() / updateX() / deleteX()
    DB->>DB: mutate data object in place

    DB->>DB: JSON.stringify(data, null, 2)
    alt sessionPassword is set
        DB->>Cry: encryptData(json, sessionPassword)
        Cry-->>DB: JSON envelope with budgetEncV1 + salt + iv + ciphertext
    end

    DB->>Tau: invoke("save_data", path, fileContent)
    Tau->>Disk: fs::write(path, fileContent)
    DB->>DB: data = spread data (new ref for React)
    DB->>Comp: notify listeners, trigger re-render
```

## Encrypted file format

Plain JSON files are human-readable. Encrypted files are a JSON object:

```json
{
  "budgetEncV1": 1,
  "salt": "<base64, 16 bytes>",
  "iv": "<base64, 12 bytes>",
  "data": "<base64 AES-GCM ciphertext>"
}
```

`isEncryptedFile()` detects the format by checking for the `"budgetEncV1"` marker string.

## Crypto details

All cryptography is in `src/utils/crypto.ts` using the Web Crypto API (`crypto.subtle`):

- **Cipher:** AES-256-GCM
- **Key derivation:** PBKDF2-SHA256, 100,000 iterations, 16-byte random salt per write
- **IV:** 12-byte random, generated fresh on every `encryptData()` call
- **Wrong password:** AES-GCM authentication fails and `decryptData()` throws `"Wrong password or corrupted file"`

`sessionPassword` is kept in a module-level variable inside `db.ts` and is never written to disk.

## Startup cleanup

After a successful `JSON.parse`, `loadFromFile()` calls `startupCleanup()` (`db.ts:401`). This runs a set of one-time data migrations keyed by string ID in `AppData.completedMigrations` — fixes stale transaction links, normalizes instrument names, backfills category colors, deduplicates bank_csv overlaps, and applies split rules retroactively. Each migration writes its ID to `completedMigrations` so it only runs once.

## Files involved

| File | Role |
|---|---|
| `src/components/FileSetup.tsx` | First-run UI — opens last file automatically, shows open/create/template buttons |
| `src/components/PasswordPrompt.tsx` | Password entry screen rendered when `loadFromFile()` throws `FILE_ENCRYPTED` |
| `src/utils/crypto.ts` | `encryptData()`, `decryptData()`, `isEncryptedFile()` |
| `src/db.ts` | `loadFromFile()`, `persist()`, `createNewFile()`, `createDemoFile()`, `enableEncryption()` |
| `src-tauri/src/lib.rs` | `load_data`, `save_data`, `get_last_file_path`, `set_file_path` Tauri commands |
