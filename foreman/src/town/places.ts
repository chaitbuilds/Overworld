// The town's places: where something can be asked for (a building, a quarter's gate). Made from the town's layout
// (codetown/layout.ts placesOf), written to places.json by scripts/codetown-map.ts for the game, and sent to the game
// in the town's record.
import type { Box6, Vec } from './engine.js';

export interface Place {
  id: string;
  name: string;
  boxes: Box6[];
  /** What a sign aimed at selects this place (its boxes when not given). */
  aim?: Box6[];
  /** What is outlined while a sign is aimed at the place (its boxes when not given). */
  outline?: Box6[];
  /** Where the marker with the asker's words stands. */
  stake?: Vec;
  /** Where agents stand while they work here, and the way they face. */
  stand?: Vec;
  standYaw?: number;
  anchors: Record<string, Vec>;
  lists: Record<string, Vec[]>;
  notes: string;
}
export interface PlacesFile {
  version: number;
  places: Place[];
  /** Where idle agents wait. */
  green?: Vec;
}
