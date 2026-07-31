import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  AiMemory,
  AiMemoryKind,
  AiMemoryPriorStatement,
  AiMemoryScope,
} from '../../../shared/types';

/**
 * Durable statements about how the owner runs their money, which the ledger cannot show.
 *
 * WHAT THIS STORE ENFORCES. Shape, and only shape: a statement and an evidence line of usable
 * length, a kind drawn from four dispositional members, a subject exactly when the scope needs one,
 * one live row per wording. Each of those is a property of the row that holds every time it is read.
 *
 * WHAT IT DELIBERATELY DOES NOT ENFORCE. That a statement carries no figure. A pattern cannot
 * separate a disposition from a measurement, and the sentences prove it: `401(k)`, `529`, `1099`,
 * `403(b)`, `the 1st of each month` and `the 15th` are digits inside durable sentences, while
 * "four hundred dollars a month", "twelve thousand in the checking buffer" and "90 in revolving
 * balance" are measurements, and only one of those three carries a currency mark at all. Any rule
 * loose enough to admit the first six admits the last three. The owner trusts a refusal, so a
 * refusal wrong in both directions is worse than no refusal: this store has none.
 *
 * STALENESS IS MADE HARMLESS RATHER THAN IMPOSSIBLE. Every statement reaches the prompt carrying
 * the date it was recorded and the number of observations behind it (`pushMemory` in aiContext.ts),
 * under a heading that instructs the model to read each line as of that date. A figure inside a
 * dated statement is a figure as of that day whatever shape it took, which covers the bare numbers
 * no pattern could have caught.
 *
 * See migration 049 for the constraints the engine enforces.
 */

const KINDS: readonly AiMemoryKind[] = ['preference', 'constraint', 'intent', 'interpretation'];
const SCOPES: readonly AiMemoryScope[] = ['household', 'account', 'category', 'merchant', 'goal'];

const STATEMENT_MIN = 12;
const STATEMENT_MAX = 400;
const EVIDENCE_MIN = 12;
const EVIDENCE_MAX = 600;
const SUBJECT_MAX = 120;

export type AiMemoryWriteResult =
  | { ok: true; memory: AiMemory }
  | { ok: false; error: string; not_found?: true };

interface MemoryRow {
  id: string;
  scope: AiMemoryScope;
  subject: string | null;
  statement: string;
  kind: AiMemoryKind;
  evidence: string;
  evidence_count: number;
  source: 'owner' | 'ai';
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `
  id, scope, subject, statement, kind, evidence, evidence_count, source,
  superseded_by, superseded_at, created_at
`;

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isKind(value: unknown): value is AiMemoryKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function isScope(value: unknown): value is AiMemoryScope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

interface NormalizedMemory {
  scope: AiMemoryScope;
  subject: string | null;
  statement: string;
  kind: AiMemoryKind;
  evidence: string;
  evidence_count: number;
}

/** Request bodies arrive unshaped, so every field is narrowed here rather than asserted at the route. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? normalizeSpace(value) : '';
}

function validate(raw: unknown): { ok: true; value: NormalizedMemory } | { ok: false; error: string } {
  const input = asRecord(raw);
  if (!isScope(input.scope)) {
    return { ok: false, error: `scope must be one of: ${SCOPES.join(', ')}` };
  }
  if (!isKind(input.kind)) {
    return { ok: false, error: `kind must be one of: ${KINDS.join(', ')}` };
  }
  const scope = input.scope;

  const statement = text(input.statement);
  if (statement.length < STATEMENT_MIN || statement.length > STATEMENT_MAX) {
    return { ok: false, error: `statement must be between ${STATEMENT_MIN} and ${STATEMENT_MAX} characters` };
  }
  const evidence = text(input.evidence);
  if (evidence.length < EVIDENCE_MIN || evidence.length > EVIDENCE_MAX) {
    return {
      ok: false,
      error: `evidence must be between ${EVIDENCE_MIN} and ${EVIDENCE_MAX} characters: every memory has to say what was observed to conclude it`,
    };
  }

  const subject = text(input.subject);
  if (scope === 'household' && subject) {
    return { ok: false, error: 'a household statement is about your finances as a whole and takes no subject' };
  }
  if (scope !== 'household' && !subject) {
    return { ok: false, error: `a ${scope} statement must name the ${scope} it is about` };
  }
  if (subject.length > SUBJECT_MAX) {
    return { ok: false, error: `subject must be ${SUBJECT_MAX} characters or fewer` };
  }

  const count = input.evidence_count ?? 1;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    return { ok: false, error: 'evidence_count must be a whole number of at least 1' };
  }

  return {
    ok: true,
    value: {
      scope,
      subject: scope === 'household' ? null : subject,
      statement,
      kind: input.kind,
      evidence,
      evidence_count: count,
    },
  };
}

function liveDuplicate(db: Database.Database, statement: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM ai_memory
    WHERE superseded_by IS NULL AND lower(trim(statement)) = lower(trim(?))
  `).get(statement);
  return row !== undefined;
}

/**
 * Walks a live entry's supersede chain backwards. Bounded rather than trusting the data: the
 * schema forbids a row superseding itself, but nothing forbids a longer cycle, and a prompt
 * builder that can loop forever on a malformed row is not a trade worth making.
 */
const MAX_CHAIN = 50;

function priorStatements(byNewer: Map<string, MemoryRow>, liveId: string): AiMemoryPriorStatement[] {
  const priors: AiMemoryPriorStatement[] = [];
  const seen = new Set<string>([liveId]);
  let cursor = byNewer.get(liveId);
  while (cursor && !seen.has(cursor.id) && priors.length < MAX_CHAIN) {
    seen.add(cursor.id);
    priors.push({
      id: cursor.id,
      statement: cursor.statement,
      evidence: cursor.evidence,
      // Non-null by CHECK: superseded_at is set exactly when superseded_by is.
      superseded_at: cursor.superseded_at ?? cursor.created_at,
    });
    cursor = byNewer.get(cursor.id);
  }
  return priors;
}

function toMemory(row: MemoryRow, priors: AiMemoryPriorStatement[]): AiMemory {
  return {
    id: row.id,
    scope: row.scope,
    subject: row.subject,
    statement: row.statement,
    kind: row.kind,
    evidence: row.evidence,
    evidence_count: row.evidence_count,
    source: row.source,
    created_at: row.created_at,
    prior_statements: priors,
  };
}

/** Live entries only, oldest first, each carrying the statements it replaced. */
export function listMemories(db: Database.Database): AiMemory[] {
  const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM ai_memory`).all() as MemoryRow[];
  const byNewer = new Map<string, MemoryRow>();
  for (const row of rows) {
    if (row.superseded_by) byNewer.set(row.superseded_by, row);
  }
  return rows
    .filter((row) => row.superseded_by === null)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((row) => toMemory(row, priorStatements(byNewer, row.id)));
}

function readMemory(db: Database.Database, id: string): MemoryRow | undefined {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM ai_memory WHERE id = ?`).get(id) as
    | MemoryRow
    | undefined;
}

/** One read of the chain, so a write returns the same shape the list endpoint serves. */
function readMemoryWithChain(db: Database.Database, id: string): AiMemory {
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM ai_memory WHERE superseded_by IS NOT NULL OR id = ?`
  ).all(id) as MemoryRow[];
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`ai_memory row ${id} vanished immediately after it was written`);
  const byNewer = new Map<string, MemoryRow>();
  for (const candidate of rows) {
    if (candidate.superseded_by) byNewer.set(candidate.superseded_by, candidate);
  }
  return toMemory(row, priorStatements(byNewer, id));
}

/** `input` is an unvalidated request body; AiMemoryInput documents the shape it is checked against. */
export function createMemory(
  db: Database.Database,
  input: unknown,
  source: 'owner' | 'ai' = 'owner'
): AiMemoryWriteResult {
  const checked = validate(input);
  if (!checked.ok) return checked;
  if (liveDuplicate(db, checked.value.statement)) {
    return { ok: false, error: 'That statement is already recorded' };
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_memory
      (id, scope, subject, statement, kind, evidence, evidence_count, source,
       superseded_by, superseded_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(
    id,
    checked.value.scope,
    checked.value.subject,
    checked.value.statement,
    checked.value.kind,
    checked.value.evidence,
    checked.value.evidence_count,
    source,
    now
  );

  return { ok: true, memory: readMemoryWithChain(db, id) };
}

/**
 * Replace a belief with what it became, keeping what it was.
 *
 * The new row's evidence_count does not inherit the old one's. A revision is a different belief
 * with different support, and carrying the count forward would let one observation of the new
 * statement inherit eight observations of the old.
 */
export function supersedeMemory(
  db: Database.Database,
  id: string,
  revision: unknown,
  source: 'owner' | 'ai' = 'owner'
): AiMemoryWriteResult {
  const existing = readMemory(db, id);
  if (!existing) return { ok: false, error: 'Memory not found', not_found: true };
  if (existing.superseded_by) {
    return { ok: false, error: 'That statement has already been replaced' };
  }

  const patch = asRecord(revision);
  // Scope and subject are carried, never taken from the request: a statement about a different
  // subject is a different belief and belongs in its own entry, not in this one's history.
  const checked = validate({
    scope: existing.scope,
    subject: existing.subject,
    statement: patch.statement,
    kind: patch.kind ?? existing.kind,
    evidence: patch.evidence,
    evidence_count: patch.evidence_count,
  });
  if (!checked.ok) return checked;
  // The entry being replaced is still live at this point, so it would match itself.
  if (
    checked.value.statement.toLowerCase() !== existing.statement.toLowerCase() &&
    liveDuplicate(db, checked.value.statement)
  ) {
    return { ok: false, error: 'That statement is already recorded' };
  }

  const newId = uuidv4();
  const now = new Date().toISOString();
  // Retire first, then insert. The unique index covers live statements only, so a revision that
  // keeps the wording and restates the evidence would collide with itself in the other order. The
  // forward reference holds because migration 049 defers this foreign key to COMMIT.
  const apply = db.transaction(() => {
    db.prepare('UPDATE ai_memory SET superseded_by = ?, superseded_at = ? WHERE id = ?').run(
      newId,
      now,
      id
    );
    db.prepare(`
      INSERT INTO ai_memory
        (id, scope, subject, statement, kind, evidence, evidence_count, source,
         superseded_by, superseded_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      newId,
      checked.value.scope,
      checked.value.subject,
      checked.value.statement,
      checked.value.kind,
      checked.value.evidence,
      checked.value.evidence_count,
      source,
      now
    );
  });
  apply();

  return { ok: true, memory: readMemoryWithChain(db, newId) };
}

/**
 * Strike a belief. The supersede chain goes with it, by ON DELETE CASCADE: a statement the owner
 * rejected must leave nothing behind that a model could read back.
 */
export function deleteMemory(db: Database.Database, id: string): { changed: number } {
  const result = db.prepare('DELETE FROM ai_memory WHERE id = ?').run(id);
  return { changed: result.changes };
}
