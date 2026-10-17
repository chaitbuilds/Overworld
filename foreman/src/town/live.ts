// The real world as a driver: what the town draws becomes an operation sent to the game over the backend's link
// (`town.do`), and the game's answer (`town.event` kind "done" or "error") settles the promise. The game carries each
// operation out itself, tick by tick, so nothing here waits on message timing for motion.
import type { Box6, Placement, Vec, WorldDriver } from './engine.js';

export interface GameEvent { kind: string; id?: string; [key: string]: unknown }
type Op = Record<string, unknown>;

export class LiveDriver implements WorldDriver {
  private pending = new Map<string, { resolve: (e: GameEvent) => void; reject: (e: Error) => void; part?: string }>();
  private next = 1;
  private batch: Op[] = [];
  private scheduled = false;
  /** Operations sent so far (for the run's evidence). */
  sent = 0;

  constructor(private send: (ops: Op[]) => void) {}

  private push(op: Op): void {
    this.batch.push(op);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; const ops = this.batch; this.batch = []; this.sent += ops.length; if (ops.length) this.send(ops); });
  }
  private ask(op: Op): Promise<GameEvent> {
    const id = `o${this.next++}`;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, part: op.part as string | undefined }); this.push({ ...op, id }); });
  }
  /** An operation the game has finished or refused. Returns true when it settled something. */
  settle(e: GameEvent): boolean {
    if (typeof e.id !== 'string') return false;
    const p = this.pending.get(e.id);
    if (!p) return false;
    this.pending.delete(e.id);
    if (e.kind === 'error') p.reject(new Error(String(e.message ?? 'the game refused it'))); else p.resolve(e);
    return true;
  }
  /** The world went away (the game closed or reloaded): nothing still waiting will be answered. */
  abandon(why: string): void {
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }
  get waiting(): number { return this.pending.size; }

  begin(part: string, boxes: Box6[], open: boolean): void { this.push({ op: 'part.begin', part, boxes, open }); }
  build(part: string, blocks: Placement[], seconds: number | undefined): Promise<{ placed: number; refused: string[] }> {
    return this.ask({ op: 'blocks', part, blocks, ...(seconds === undefined ? {} : { seconds }) }).then((e) => ({ placed: Number(e.placed ?? 0), refused: (e.bad as string[] | undefined) ?? [] }));
  }
  label(part: string, id: string, at: Vec, text: string, scale: number | undefined, fixed?: { yaw?: number; width?: number; left?: boolean; background?: number }): void {
    this.push({ op: 'label', part, label: id, at, text, ...(scale === undefined ? {} : { scale }), ...(fixed?.yaw === undefined ? {} : { yaw: fixed.yaw }), ...(fixed?.width === undefined ? {} : { width: fixed.width }), ...(fixed?.left ? { align: 'left' } : {}), ...(fixed?.background === undefined ? {} : { background: fixed.background }) });
  }
  labelRemove(part: string, id: string): void { this.push({ op: 'label.remove', part, label: id }); }
  watch(part: string, key: string, kind: 'use' | 'zone' | 'container', box: Box6): void { this.push({ op: 'watch', part, key, kind, box }); }
  sound(part: string, name: string, at: Vec, volume: number | undefined, pitch: number | undefined): void { this.push({ op: 'sound', part, name, at, ...(volume === undefined ? {} : { volume }), ...(pitch === undefined ? {} : { pitch }) }); }
}
