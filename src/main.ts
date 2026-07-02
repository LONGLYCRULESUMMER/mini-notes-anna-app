import "./style.css";
import { connect } from "./anna";
import { NotesStore, type Note } from "./notesStore";
import { summarizeNotes } from "./summarize";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

const els = {
  conn: $("#conn-status"),
  input: $<HTMLInputElement>("#note-input"),
  addBtn: $<HTMLButtonElement>("#add-btn"),
  list: $<HTMLOListElement>("#notes-list"),
  empty: $("#empty-state"),
  error: $("#error-banner"),
  summarizeBtn: $<HTMLButtonElement>("#summarize-btn"),
  summaryPanel: $("#summary-panel"),
  summaryText: $("#summary-text"),
  summaryMeta: $("#summary-meta"),
};

let store: NotesStore | null = null;
let busy = false;

async function init(): Promise<void> {
  bindUi();
  render([]);

  let anna;
  try {
    anna = await connect();
  } catch (e) {
    setConn(false);
    showError(
      "未连接到 Anna host — 请通过 `anna-app dev` 打开本应用（standalone 预览下 storage/tools 不可用）。",
    );
    return;
  }
  setConn(true);
  anna.window.set_title({ title: "Mini Notes" }).catch(() => {});

  store = new NotesStore(anna);
  try {
    render(await store.load());
  } catch (e) {
    showError(`读取 notes 失败: ${message(e)}`);
  }
}

function bindUi(): void {
  els.addBtn.addEventListener("click", onAdd);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAdd();
  });
  els.summarizeBtn.addEventListener("click", onSummarize);
  els.input.addEventListener("input", () => {
    els.addBtn.disabled = !els.input.value.trim();
  });
  els.addBtn.disabled = true;
}

async function onAdd(): Promise<void> {
  if (!store || busy) return;
  const text = els.input.value;
  if (!text.trim()) return; // empty input must not be saved
  await run(async () => {
    await store!.add(text);
    els.input.value = ""; // clear the composer after a successful save
    els.addBtn.disabled = true;
    render(store!.notes);
  }, "保存笔记失败");
}

async function onDelete(note: Note): Promise<void> {
  if (!store || busy) return;
  await run(async () => {
    await store!.remove(note.id);
    render(store!.notes); // list updates immediately after storage.set resolves
  }, "删除笔记失败");
}

async function onSummarize(): Promise<void> {
  if (!store || busy || store.notes.length === 0) return;
  els.summarizeBtn.textContent = "Summarizing…";
  await run(async () => {
    const anna = await connect();
    // Reload from the storage Host API first so the summary always
    // reflects what is actually persisted, not just local state.
    const notes = await store!.load();
    render(notes);
    const result = await summarizeNotes(anna, notes);
    els.summaryPanel.hidden = false;
    els.summaryText.textContent = result.summary;
    els.summaryMeta.textContent = result.model
      ? `model: ${result.model}${result.stopReason ? ` · ${result.stopReason}` : ""}`
      : "";
  }, "Summarize 失败");
  els.summarizeBtn.textContent = "Summarize";
}

async function run(fn: () => Promise<void>, errPrefix: string): Promise<void> {
  busy = true;
  hideError();
  document.body.classList.add("is-busy");
  try {
    await fn();
  } catch (e) {
    showError(`${errPrefix}: ${message(e)}`);
  } finally {
    busy = false;
    document.body.classList.remove("is-busy");
  }
}

function render(notes: readonly Note[]): void {
  els.list.innerHTML = "";
  for (const note of notes) {
    const li = document.createElement("li");
    li.className = "note";

    const seq = document.createElement("span");
    seq.className = "note__seq";
    seq.textContent = `#${note.seq}`;

    const body = document.createElement("div");
    body.className = "note__body";
    const text = document.createElement("p");
    text.className = "note__text";
    text.textContent = note.text;
    const time = document.createElement("time");
    time.className = "note__time";
    time.dateTime = note.created_at;
    time.textContent = formatTime(note.created_at);
    body.append(text, time);

    const del = document.createElement("button");
    del.className = "note__delete";
    del.type = "button";
    del.textContent = "删除";
    del.setAttribute("aria-label", `删除笔记 #${note.seq}`);
    del.addEventListener("click", () => onDelete(note));

    li.append(seq, body, del);
    els.list.appendChild(li);
  }
  els.empty.hidden = notes.length > 0;
  els.summarizeBtn.disabled = notes.length === 0;
}

function setConn(on: boolean): void {
  els.conn.textContent = on ? "connected" : "offline";
  els.conn.classList.toggle("badge--on", on);
  els.conn.classList.toggle("badge--off", !on);
}

function showError(msg: string): void {
  els.error.textContent = msg;
  els.error.hidden = false;
}

function hideError(): void {
  els.error.hidden = true;
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const anyE = e as { message?: string; code?: string | number };
    if (anyE.message) {
      return anyE.code != null ? `[${anyE.code}] ${anyE.message}` : anyE.message;
    }
    return JSON.stringify(e);
  }
  return String(e);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => showError(message(e)));
});
