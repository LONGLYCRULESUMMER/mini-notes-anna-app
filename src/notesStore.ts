import type { AnnaRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { STORAGE_KEY } from "./config";

export interface Note {
  id: string;
  /** 1-based insertion order, never reused after deletes. */
  seq: number;
  text: string;
  created_at: string;
}

interface NotesState {
  seq: number;
  items: Note[];
}

const EMPTY: NotesState = { seq: 0, items: [] };

/**
 * Notes repository backed exclusively by the Anna storage Host API
 * (`anna.storage.get` / `anna.storage.set`). No localStorage, no
 * IndexedDB — every read and write is a host RPC so the data lives in
 * the platform bucket (legacy in-memory runtime_state under
 * `anna-app dev`, APS KV in production).
 */
export class NotesStore {
  private state: NotesState = EMPTY;

  constructor(private anna: AnnaRuntime) {}

  get notes(): readonly Note[] {
    return this.state.items;
  }

  /** Load notes from storage (called once at boot). */
  async load(): Promise<readonly Note[]> {
    const res = await this.anna.storage.get({ key: STORAGE_KEY });
    this.state = isNotesState(res?.value) ? res.value : { ...EMPTY, items: [] };
    return this.state.items;
  }

  /** Append a note and persist through storage.set. Rejects blank input. */
  async add(text: string): Promise<Note> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("笔记内容不能为空");
    const note: Note = {
      id: crypto.randomUUID(),
      seq: this.state.seq + 1,
      text: trimmed,
      created_at: new Date().toISOString(),
    };
    const next: NotesState = {
      seq: note.seq,
      items: [...this.state.items, note],
    };
    await this.persist(next);
    return note;
  }

  /** Delete one note by id and persist the updated list through storage.set. */
  async remove(id: string): Promise<void> {
    const items = this.state.items.filter((n) => n.id !== id);
    if (items.length === this.state.items.length) return;
    await this.persist({ seq: this.state.seq, items });
  }

  private async persist(next: NotesState): Promise<void> {
    await this.anna.storage.set({ key: STORAGE_KEY, value: next });
    // Only commit locally after the host acknowledged the write.
    this.state = next;
  }
}

function isNotesState(v: unknown): v is NotesState {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as NotesState).seq === "number" &&
    Array.isArray((v as NotesState).items)
  );
}
