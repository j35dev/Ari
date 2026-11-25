import { access } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'

// Self-contained worker source also works in Electron's bundled main entry.
// SQLite and compression never run on the main event loop.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
mkdirSync(dirname(workerData.path), { recursive: true });
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA journal_size_limit=16777216');
const version = db.prepare('PRAGMA user_version').get().user_version;
if (version !== 0 && version !== 1) throw new Error('Unsupported conversation database version');
db.exec(
  'CREATE TABLE IF NOT EXISTS conversations (' +
  'id TEXT PRIMARY KEY, created_json TEXT NOT NULL, state_json TEXT NOT NULL, index_json TEXT NOT NULL, diagnostics_json TEXT NOT NULL, last_seq INTEGER NOT NULL);' +
  'CREATE TABLE IF NOT EXISTS conversation_messages (' +
  'session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(session_id,id));' +
  'CREATE INDEX IF NOT EXISTS conversation_messages_order ON conversation_messages(session_id,ordinal);' +
  'CREATE TABLE IF NOT EXISTS conversation_history (' +
  'id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, payload BLOB NOT NULL, redundant INTEGER NOT NULL DEFAULT 0);' +
  'CREATE INDEX IF NOT EXISTS conversation_history_range ON conversation_history(session_id,last_seq,first_seq);' +
  'PRAGMA user_version=1;'
);
function transaction(body) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = body(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
// Additive, so older builds still open the file: they ignore the column and index.
if (!db.prepare('PRAGMA table_info(conversation_history)').all().some(column => column.name === 'redundant')) transaction(() => {
  db.exec('ALTER TABLE conversation_history ADD COLUMN redundant INTEGER NOT NULL DEFAULT 0');
  // A delivery bug re-recorded the same acknowledgment every second or so. Those
  // rows stay for exact replay; transcript hydration skips them.
  const repeated = [];
  let session = null, seen = new Set();
  for (const row of db.prepare('SELECT id,session_id,payload FROM conversation_history ORDER BY session_id,id').iterate()) {
    if (row.session_id !== session) { session = row.session_id; seen = new Set(); }
    let fresh = false, events;
    // An unreadable row stays visible; replay reports it as before.
    try { events = JSON.parse(gunzipSync(row.payload).toString('utf8')); } catch { continue; }
    if (!Array.isArray(events) || !events.length) continue;
    for (const event of events) {
      if (!event || typeof event !== 'object') { fresh = true; continue; }
      if (event.type !== 'child.session.acknowledged') { fresh = true; continue; }
      const key = event.childSessionId + '|' + event.turnId;
      if (!seen.has(key)) { seen.add(key); fresh = true; }
    }
    if (!fresh) repeated.push(row.id);
  }
  const mark = db.prepare('UPDATE conversation_history SET redundant=1 WHERE id=?');
  for (const id of repeated) mark.run(id);
});
// Pages walk history by id; without this index every page sorted the whole conversation.
db.exec('CREATE INDEX IF NOT EXISTS conversation_history_order ON conversation_history(session_id,id)');
const read = db.prepare('SELECT * FROM conversations WHERE id=?');
const list = db.prepare('SELECT id,index_json FROM conversations');
const messages = db.prepare('SELECT payload_json FROM conversation_messages WHERE session_id=? ORDER BY ordinal');
const save = db.prepare('INSERT INTO conversations(id,created_json,state_json,index_json,diagnostics_json,last_seq) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,index_json=excluded.index_json,diagnostics_json=excluded.diagnostics_json,last_seq=excluded.last_seq');
const saveMessage = db.prepare('INSERT INTO conversation_messages(session_id,id,ordinal,payload_json) VALUES (?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET ordinal=excluded.ordinal,payload_json=excluded.payload_json');
const saveHistory = db.prepare('INSERT INTO conversation_history(session_id,first_seq,last_seq,payload) VALUES (?,?,?,?)');
const history = db.prepare('SELECT id,payload FROM conversation_history WHERE session_id=? AND id>? ORDER BY id');
const transcriptHistory = db.prepare('SELECT id,payload FROM conversation_history WHERE session_id=? AND id>? AND redundant=0 ORDER BY id');
const remove = db.prepare('DELETE FROM conversations WHERE id=?');
function writeHistory(sessionId, events) {
  let batch = [], bytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const json = '[' + batch.map(event => event.json).join(',') + ']';
    saveHistory.run(sessionId, batch[0].seq, batch[batch.length-1].seq, gzipSync(json, { level: 1 }));
    batch = []; bytes = 0;
  };
  for (const event of events) {
    const size = Buffer.byteLength(event.json);
    if (batch.length && bytes + size > 128*1024) flush();
    batch.push(event); bytes += size;
  }
  flush();
}
parentPort.on('message', ({ id, op, args }) => {
  try {
    let result;
    if (op === 'head') result = read.get(args.sessionId) || null;
    else if (op === 'get') {
      const row = read.get(args.sessionId);
      result = row ? { ...row, messages: messages.all(args.sessionId).map(row => row.payload_json) } : null;
    } else if (op === 'list') result = list.all();
    else if (op === 'history') {
      // About a megabyte per round trip, however finely the rows were written.
      result = []; let size = 0;
      for (const row of (args.transcript ? transcriptHistory : history).iterate(args.sessionId, args.afterId)) {
        const json = gunzipSync(row.payload).toString('utf8');
        result.push({ id: row.id, json });
        size += json.length;
        if (size >= 1024 * 1024) break;
      }
    } else if (op === 'save') result = transaction(() => {
      const existing = read.get(args.sessionId);
      if (args.import && existing) return false;
      const expected = existing ? existing.last_seq + 1 : 0;
      // Imports keep legacy gaps/corruption diagnostics. Ordinary writes must be contiguous.
      if (!args.import && (args.events[0]?.seq !== expected || args.events.some((event,index) => event.seq !== expected+index))) throw new Error('Conversation sequence conflict');
      save.run(args.sessionId,args.created,args.state,args.index,args.diagnostics,args.lastSeq);
      for (const message of args.messages) saveMessage.run(args.sessionId,message.id,message.ordinal,message.json);
      writeHistory(args.sessionId,args.events);
      return true;
    });
    else if (op === 'delete') result = transaction(() => remove.run(args.sessionId).changes > 0);
    else if (op === 'close') { db.close(); parentPort.postMessage({ id, result: null }); parentPort.close(); return; }
    else throw new Error('Unknown conversation database operation');
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: String(error.message || error) }); }
});
`

export interface ConversationRow {
  id: string
  created_json: string
  state_json: string
  index_json: string
  diagnostics_json: string
  last_seq: number
  messages: string[]
}

export interface ConversationCommit {
  sessionId: string
  created: string
  state: string
  index: string
  diagnostics: string
  lastSeq: number
  messages: { id: string; ordinal: number; json: string }[]
  events: { seq: number; json: string }[]
  import?: boolean
}

export class ConversationDatabase {
  #worker: Worker | null = null
  #nextId = 0
  #failure: Error | null = null
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  constructor(readonly path: string) {}

  async exists(): Promise<boolean> {
    if (this.#worker) return true
    try {
      await access(this.path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  #start(): Worker {
    if (this.#failure) throw this.#failure
    if (this.#worker) return this.#worker
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path: this.path } })
    this.#worker = worker
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
      if (this.#pending.size === 0) worker.unref()
    })
    const fail = (error: Error): void => {
      this.#failure = error
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
      worker.unref()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = null
      if (this.#pending.size || code !== 0)
        fail(new Error(`Conversation database worker exited (${code})`))
    })
    worker.unref()
    return worker
  }

  #request<T>(op: string, args: unknown): Promise<T> {
    const worker = this.#start()
    const id = ++this.#nextId
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject })
      worker.ref()
      worker.postMessage({ id, op, args })
    })
  }

  async get(sessionId: string): Promise<ConversationRow | null> {
    return (await this.exists()) ? this.#request('get', { sessionId }) : null
  }
  async head(sessionId: string): Promise<Omit<ConversationRow, 'messages'> | null> {
    return (await this.exists()) ? this.#request('head', { sessionId }) : null
  }
  async list(): Promise<{ id: string; index_json: string }[]> {
    return (await this.exists()) ? this.#request('list', {}) : []
  }
  save(commit: ConversationCommit): Promise<boolean> {
    return this.#request('save', commit)
  }
  /** `transcript` leaves out stored repeats that change nothing a transcript shows. */
  async history(
    sessionId: string,
    afterId: number,
    transcript = false,
  ): Promise<{ id: number; json: string }[]> {
    return (await this.exists()) ? this.#request('history', { sessionId, afterId, transcript }) : []
  }
  async delete(sessionId: string): Promise<boolean> {
    return (await this.exists()) ? this.#request('delete', { sessionId }) : false
  }
  async close(): Promise<void> {
    const worker = this.#worker
    if (!worker) return
    await this.#request('close', {})
    await worker.terminate()
    if (this.#worker === worker) this.#worker = null
  }
}

export function savedMessages(
  messages: readonly Message[],
  changed?: ReadonlySet<string>,
): ConversationCommit['messages'] {
  return messages.flatMap((message, ordinal) =>
    changed && !changed.has(message.id)
      ? []
      : [{ id: message.id, ordinal, json: JSON.stringify(message) }],
  )
}
export function savedEvents(events: readonly JournalEvent[]): ConversationCommit['events'] {
  return events.map((event) => ({ seq: event.seq, json: JSON.stringify(event) }))
}
