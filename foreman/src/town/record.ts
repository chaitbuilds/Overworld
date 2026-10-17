// The town's record: a file of JSON lines the backend appends to as things happen (OVERWORLD_RECORD). Each
// line carries its wall-clock time in `ms`. A line of kind "list" is the whole code list as it stood then: one row for
// each module of the change in hand (its name, its place, whether it is planned, being worked on, merged or stopped,
// and one line of plain words with who is writing or testing it and the counts), and one row for the ask as a whole.
import fs from 'node:fs';
import path from 'node:path';

export interface ListRow { part: string; plot: string; state: 'planned' | 'work' | 'live' | 'failed'; text: string }

export class TownRecord {
  private last = '';
  /** Everything written so far (kept for tests). */
  readonly rows: Array<Record<string, unknown>> = [];

  constructor(private file: string | undefined, private now: () => number = () => Date.now()) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Something happened: one line with its time. The time field is `ms`; no row may carry a field named "at". */
  write(kind: string, data: Record<string, unknown>): void {
    const row = { ms: this.now(), kind, ...data };
    this.rows.push(row); if (this.rows.length > 5000) this.rows.shift();
    if (this.file) { try { fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`); } catch { /* the record is evidence, not a dependency */ } }
  }
  /** The code list as it stands, written only when it differs from the last one written. */
  list(rows: ListRow[]): boolean {
    const sig = JSON.stringify(rows);
    if (sig === this.last || (!rows.length && !this.last)) return false;
    this.last = sig;
    this.write('list', { rows });
    return true;
  }
}
