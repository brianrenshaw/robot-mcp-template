// db.ts
// Every database query, and nothing else. Keeping all the SQL in one file means there is one
// place to look when the data is wrong, and the tools stay easy to read.
//
// This is the example (notes). Replace it with whatever your project keeps.

export interface Note {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  deleted_at: string | null;
}

/** Thrown when words match more than one note. The tool hands the choices back; it never guesses. */
export class AmbiguousError extends Error {
  constructor(
    message: string,
    public candidates: { id: string; title: string }[],
  ) {
    super(message);
  }
}

export class NotFoundError extends Error {}

const now = () => new Date().toISOString();

/** Notes, newest first. With words, only notes that contain every word in the title or body. */
export async function listNotes(db: D1Database, query?: string, limit = 25): Promise<Note[]> {
  const words = (query ?? "").split(/\s+/).filter(Boolean);
  const where = words.map(() => `(title LIKE ? OR body LIKE ?)`).join(" AND ");
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
  const { results } = await db
    .prepare(`SELECT * FROM notes WHERE deleted_at IS NULL ${where ? `AND ${where}` : ""} ORDER BY updated_at DESC LIMIT ?`)
    .bind(...params, limit)
    .all<Note>();
  return results;
}

/**
 * Find one note by its id or by words from its title. If the words fit more than one note,
 * this throws with the candidates so the chatbot can ask which one was meant.
 */
export async function requireNote(db: D1Database, ref: string, includeDeleted = false): Promise<Note> {
  const live = includeDeleted ? "" : "AND deleted_at IS NULL";
  const byId = await db.prepare(`SELECT * FROM notes WHERE id = ? ${live}`).bind(ref).first<Note>();
  if (byId) return byId;
  const words = ref.split(/\s+/).filter(Boolean);
  if (!words.length) throw new NotFoundError("Say which note: its id or some words from its title.");
  const { results } = await db
    .prepare(`SELECT * FROM notes WHERE ${words.map(() => "title LIKE ?").join(" AND ")} ${live} ORDER BY updated_at DESC LIMIT 6`)
    .bind(...words.map((w) => `%${w}%`))
    .all<Note>();
  if (results.length === 1) return results[0]!;
  if (!results.length) throw new NotFoundError(`No note matches "${ref}".`);
  const exact = results.filter((n) => n.title.toLowerCase() === ref.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  throw new AmbiguousError(`"${ref}" fits more than one note. Ask which one.`, results.map((n) => ({ id: n.id, title: n.title })));
}

export async function addNote(db: D1Database, actor: string, input: { title: string; body?: string }): Promise<Note> {
  const note: Note = { id: crypto.randomUUID(), title: input.title.trim(), body: input.body ?? "", created_at: now(), updated_at: now(), created_by: actor, deleted_at: null };
  await db
    .prepare(`INSERT INTO notes (id, title, body, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(note.id, note.title, note.body, note.created_at, note.updated_at, note.created_by)
    .run();
  return note;
}

export async function updateNote(db: D1Database, id: string, patch: { title?: string; body?: string }): Promise<Note> {
  const note = await requireNote(db, id);
  const next = { ...note, title: patch.title?.trim() ?? note.title, body: patch.body ?? note.body, updated_at: now() };
  await db.prepare(`UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?`).bind(next.title, next.body, next.updated_at, id).run();
  return next;
}

/** Removing a note only marks it, so it can be brought back. Nothing is ever really deleted. */
export async function setNoteDeleted(db: D1Database, id: string, deleted: boolean): Promise<void> {
  await db.prepare(`UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(deleted ? now() : null, now(), id).run();
}
