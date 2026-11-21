// tools.ts
// What the chatbot can do, and what it is told. This is the file you change the most.
//
// Three things live here:
//   INSTRUCTIONS   what every chat reads before you say anything. Keep it SHORT (see the limit).
//   the tools      one for each thing the chatbot can do. Its description says WHEN to use it.
//   receipts       every write hands back one plain line saying what was done.
//
// The example is notes. Replace the tools with your own; keep the habits.

import { McpServer } from "@modelcontextprotocol/server";
import { z, ZodError } from "zod";
import { AmbiguousError, NotFoundError, addNote, listNotes, requireNote, setNoteDeleted, updateNote, type Note } from "./db";

/**
 * Chat apps cut long text without saying so. A Claude Code session was seen to keep only the
 * first 4,096 characters of a server's instructions, and some versions are reported to cut
 * instructions and tool descriptions at 2,048. Stay under these and nothing is lost.
 * scripts/smoke.ts fails when either is passed.
 */
export const INSTRUCTIONS_LIMIT = 4000;
export const DESCRIPTION_LIMIT = 2000;

/**
 * What every chat reads first. Say who it is for, which tool answers what, and the rules for
 * every change. Put the most important lines first. If one routine needs a lot of rules, do
 * not put them here: return them from the tool that routine starts with (see how_to below).
 */
export const INSTRUCTIONS = `This is the owner's notebook: the one place their notes are kept. They work through you: they ask you to add notes, change them and find them.

- Anything about their notes: read it from here first, every time. Never answer from memory or from earlier in the chat.
- Finding or listing notes: list_notes. A new note: add_note. Changing one: update_note. Removing one, or bringing one back: delete_note.
- Before adding a note, look for it with list_notes. If it is already here, update it. Never add a second copy.
- Never guess which note is meant. If words fit more than one, the tool lists them: ask which.
- After any change, say in one line what changed, using the receipt the tool returns. Do not read the whole note back.

That is the end of the standing instructions.`;

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });

/** Problems come back as readable answers the chatbot can act on, not as protocol failures. */
function fail(err: unknown): Result {
  const text =
    err instanceof AmbiguousError
      ? JSON.stringify({ error: err.message, candidates: err.candidates }, null, 1)
      : err instanceof ZodError
        ? `Invalid input: ${err.message}`
        : err instanceof NotFoundError
          ? err.message
          : `Server error: ${err instanceof Error ? err.message : String(err)}`;
  if (!(err instanceof AmbiguousError || err instanceof ZodError || err instanceof NotFoundError)) console.error(err);
  return { isError: true, content: [{ type: "text", text }] };
}

function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<Result> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

/** A note as the chatbot sees it: only what it needs. */
const noteBrief = (n: Note, bodyLimit = 600) => ({
  id: n.id,
  title: n.title,
  body: n.body ? (n.body.length > bodyLimit ? `${n.body.slice(0, bodyLimit)}…` : n.body) : undefined,
  updated_at: n.updated_at,
  written_by: n.created_by,
});

/** A long routine's rules travel in the result of the tool the routine starts with. */
const lines = (guide: string) => guide.split("\n");
const TIDY_GUIDE = `When they ask you to tidy up their notes:
- Read the whole list first. Notes about the same thing are candidates to join; nothing else is.
- Propose ONE short list of changes (join these two, remove this one) and wait for their yes.
- Then make the changes, and finish with one line saying how many notes changed.`;

export function buildServer(db: D1Database, actor: string): McpServer {
  const server = new McpServer({ name: "my-mcp-server", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_notes",
    {
      description:
        "Their notes, newest first. Use it for 'what notes do I have', 'find my note about the budget', and ALWAYS before adding a note that may already be there. With query, only notes that contain every word. Pass tidy true when they ask to tidy up or clean up their notes: the result then opens with how_to, the routine to follow.",
      inputSchema: z.object({
        query: z.string().optional().describe("Words to look for in the title or the text"),
        tidy: z.boolean().optional().describe("true when they asked to tidy up their notes"),
      }),
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, tidy }) => {
      const notes = await listNotes(db, query, tidy ? 200 : 25);
      return { how_to: tidy ? lines(TIDY_GUIDE) : undefined, count: notes.length, notes: notes.map((n) => noteBrief(n)) };
    }),
  );

  server.registerTool(
    "add_note",
    {
      description:
        "Save a new note. Use it when they say 'note that...', 'remember that...', 'write this down'. The title is one short line; anything longer goes in body. Look with list_notes first so the same note is not saved twice.",
      inputSchema: z.object({
        title: z.string().min(1).describe("One short line"),
        body: z.string().optional().describe("The rest, in markdown"),
      }),
    },
    safe(async (a) => {
      const note = await addNote(db, actor, a);
      return { created: true, note: noteBrief(note), receipt: `Saved the note “${note.title}”.` };
    }),
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Change a note's title or text. Only what you pass changes. note is its id or some words from its title; if the words fit more than one note the answer lists them, and you ask which one. body REPLACES the text, so to add to a note, pass the old text with the addition.",
      inputSchema: z.object({
        note: z.string().describe("The note's id, or words from its title"),
        title: z.string().min(1).optional(),
        body: z.string().optional().describe("The whole new text. Replaces what was there."),
      }),
    },
    safe(async ({ note, ...patch }) => {
      const found = await requireNote(db, note);
      const updated = await updateNote(db, found.id, patch);
      return { updated: true, note: noteBrief(updated), receipt: `Updated the note “${updated.title}”.` };
    }),
  );

  server.registerTool(
    "delete_note",
    {
      description:
        "Remove a note they no longer want, or bring one back. Nothing is destroyed: pass restore true with the same note to bring it back ('undo that', 'I didn't mean to delete it'). note is its id or words from its title; if the words fit more than one, ask which.",
      inputSchema: z.object({
        note: z.string().describe("The note's id, or words from its title"),
        restore: z.boolean().optional().describe("true brings a removed note back"),
      }),
    },
    safe(async ({ note, restore }) => {
      const found = await requireNote(db, note, !!restore);
      await setNoteDeleted(db, found.id, !restore);
      return restore
        ? { restored: true, id: found.id, receipt: `Brought back the note “${found.title}”.` }
        : { removed: true, id: found.id, receipt: `Removed the note “${found.title}”. Say "undo" to bring it back.` };
    }),
  );

  return server;
}
