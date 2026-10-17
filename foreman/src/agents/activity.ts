// Map an agent's tool use -> its state / station / nameplate activity in the town. The code town's agents have the
// file tools and the town's two tools (town/runner.ts), nothing else:
//
//   Read / Grep / Glob    -> reading      @ library
//   Edit / Write          -> editing      @ desk
//   TodoWrite             -> thinking     @ desk
//   anything else         -> running      @ terminal (run_checks, hand_in)
//
// The code town reads the file an agent is at from its activity ("editing src/app/main.ts").
import path from 'node:path';
import type { AgentState, Station } from '../protocol.js';

export interface Activity {
  state: AgentState;
  station: Station;
  activity: string;
  /** one-line log label, e.g. "Read src/cli.ts" */
  label: string;
}

function short(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Shorten an absolute path to be relative to `cwd` when inside it. */
export function relPath(p: string, cwd?: string): string {
  if (!cwd) return p;
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return p;
}

export function toolActivity(tool: string, input: Record<string, unknown>, cwd?: string): Activity {
  const name = tool.startsWith('mcp__') ? tool.split('__').pop()! : tool;
  const file = str(input.file_path) ?? str(input.path);
  const rel = file ? relPath(file, cwd) : undefined;
  switch (name) {
    case 'Read':
      return { state: 'reading', station: 'library', activity: `reading ${short(rel ?? 'files')}`, label: `Read ${rel ?? ''}`.trim() };
    case 'Grep': {
      const pat = str(input.pattern) ?? '';
      return { state: 'reading', station: 'library', activity: `searching "${pat.slice(0, 24)}"`, label: `Grep "${pat}"${rel ? ` in ${rel}` : ''}` };
    }
    case 'Glob': {
      const pat = str(input.pattern) ?? rel ?? '.';
      return { state: 'reading', station: 'library', activity: `browsing ${pat.slice(0, 30)}`, label: `${name} ${pat}` };
    }
    case 'Edit':
      return { state: 'editing', station: 'desk', activity: `editing ${short(rel ?? 'files')}`, label: `Edit ${rel ?? ''}`.trim() };
    case 'Write':
      return { state: 'editing', station: 'desk', activity: `writing ${short(rel ?? 'a file')}`, label: `Write ${rel ?? ''}`.trim() };
    case 'TodoWrite':
      return { state: 'thinking', station: 'desk', activity: 'planning steps', label: 'TodoWrite' };
    default:
      return { state: 'running', station: 'terminal', activity: name.slice(0, 40), label: name };
  }
}
