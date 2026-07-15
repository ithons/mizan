-- Stop storing the SimpleFIN access URL (which embeds basic-auth credentials) in
-- cleartext in the SQLite file. The URL is already held in the AES-256-GCM encrypted
-- credentials store (.mizan/credentials.json) and read from there at sync time; the
-- DB only ever needs to correlate the single connection row, which the fixed id
-- 'simplefin_primary' already does. Rebuilding the table without access_url also
-- purges the secret already written to disk.
CREATE TABLE simplefin_connections_new (
  id TEXT PRIMARY KEY,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

INSERT INTO simplefin_connections_new (id, last_synced_at, status, created_at)
SELECT id, last_synced_at, status, created_at FROM simplefin_connections;

DROP TABLE simplefin_connections;
ALTER TABLE simplefin_connections_new RENAME TO simplefin_connections;
