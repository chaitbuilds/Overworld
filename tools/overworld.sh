#!/usr/bin/env bash
# Overworld: your codebase as a town.
#
#   tools/overworld.sh start <repo> [--agents]   map the repository, start the backend, open the game
#   tools/overworld.sh wall <url>                show a web page (your app) on the town square's wall
#   tools/overworld.sh history                   replay the repository's history beside the town
#   tools/overworld.sh stop | status
#
# --agents: what you ask for at a building is built by Claude agent sessions (ANTHROPIC_API_KEY, or your own `claude`
#   login with OVERWORLD_BACKEND_ARGS=--use-claude-login), at most OVERWORLD_MAX_SESSIONS of them (default 40).
#   Pulling the lever merges into the branch the repository has checked out. Nothing is pushed.
#
# Settings: OVERWORLD_HOME (~/.overworld), OVERWORLD_PORT (backend, 7878), OVERWORLD_DEV_PORT (game, 7879),
#   OVERWORLD_SCREEN_PORT (wall, 4311), OVERWORLD_WINDOW (1920x1080), OVERWORLD_EXTRA_MODS (jar:jar, extra mods such as
#   a shader loader).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${OVERWORLD_HOME:-$HOME/.overworld}"
PORT="${OVERWORLD_PORT:-7878}"; DEV_PORT="${OVERWORLD_DEV_PORT:-7879}"; SCREEN_PORT="${OVERWORLD_SCREEN_PORT:-4311}"
CURRENT="$HOME_DIR/current"; LOGS="$HOME_DIR/logs"
mkdir -p "$HOME_DIR/towns" "$LOGS"
listening() { lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1; }
wait_port() { for _ in $(seq 1 "$2"); do listening "$1" && return 0; sleep 0.5; done; return 1; }
stop_port() { local pid; pid="$(lsof -tiTCP:"$1" -sTCP:LISTEN -P -n 2>/dev/null | head -1 || true)"; if [[ -n "$pid" ]]; then kill -TERM "$pid"; for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done; echo "$2 stopped"; fi; }
tsx() { (cd "$ROOT/foreman" && node --import tsx "$@"); }
current() { [[ -f "$CURRENT" ]] || { echo "No town yet: tools/overworld.sh start <repo>"; exit 2; }; repo="$(sed -n 1p "$CURRENT")"; town="$(sed -n 2p "$CURRENT")"; }

case "${1:-}" in
  start)
    repo="$(cd "${2:?usage: tools/overworld.sh start <repo> [--agents]}" && pwd)"
    [[ -e "$repo/.git" ]] || { echo "$repo is not a git repository"; exit 2; }
    [[ -d "$ROOT/foreman/node_modules" ]] || { echo "First run: npm install --prefix foreman"; exit 2; }
    if listening "$PORT" || listening "$DEV_PORT"; then echo "Overworld is already running (tools/overworld.sh stop)"; exit 2; fi
    name="$(basename "$repo")"; town="$HOME_DIR/towns/$name"
    if [[ ! -f "$town/map.json" ]]; then echo "Mapping $name..."; tsx scripts/codetown-map.ts "$repo" --dir "$town" > "$LOGS/map-$name.log"; fi
    printf '%s\n%s\n' "$repo" "$town" > "$CURRENT"

    backend=(--backend none)
    if [[ "${3:-}" == --agents ]]; then backend=(--backend claude); export OVERWORLD_MAX_SESSIONS="${OVERWORLD_MAX_SESSIONS:-40}"; fi
    (cd "$ROOT/foreman" && OVERWORLD_REPO="$repo" OVERWORLD_TOWN="$town" OVERWORLD_BRANCH="$(git -C "$repo" rev-parse --abbrev-ref HEAD)" \
      OVERWORLD_SCREEN=app nohup node --import tsx src/main.ts "${backend[@]}" --profile "$name" --home "$HOME_DIR/backend" --port "$PORT" \
      ${OVERWORLD_BACKEND_ARGS:-} >> "$LOGS/backend.log" 2>&1 &)
    wait_port "$PORT" 120 || { echo "The backend did not start; see $LOGS/backend.log"; exit 1; }

    echo "Opening the game (the first start downloads Minecraft, which takes a while)..."
    (cd "$ROOT/mod" && OVERWORLD_PORT="$PORT" OVERWORLD_DEV=1 OVERWORLD_DEV_PORT="$DEV_PORT" OVERWORLD_WORLD="$name" OVERWORLD_FOCUS="${OVERWORLD_FOCUS:-1}" \
      OVERWORLD_PLACES="$town/places.json" OVERWORLD_SCREEN_PORT="$SCREEN_PORT" \
      nohup ./gradlew runClient --console=plain ${OVERWORLD_WINDOW:+-PoverworldWindow="$OVERWORLD_WINDOW"} ${OVERWORLD_EXTRA_MODS:+-PoverworldAddMods="$OVERWORLD_EXTRA_MODS"} >> "$LOGS/game.log" 2>&1 &)
    node "$ROOT/tools/devcli.mjs" wait --port "$DEV_PORT" --timeout 900 >/dev/null || { echo "The game did not open; see $LOGS/game.log"; exit 1; }
    echo "Your town is open: $name"
    ;;
  wall)
    url="${2:?usage: tools/overworld.sh wall <url>}"
    stop_port "$SCREEN_PORT" "the wall" >/dev/null
    nohup node "$ROOT/tools/wall.mjs" "$url" --port "$SCREEN_PORT" --id app >> "$LOGS/wall.log" 2>&1 &
    wait_port "$SCREEN_PORT" 60 && echo "The wall shows $url" || { echo "The wall did not start; see $LOGS/wall.log"; exit 1; }
    ;;
  history)
    current
    echo "Reading the history of $(basename "$repo")..."
    tsx scripts/codetown-history.ts "$repo" --dir "$town" > "$LOGS/history.log"
    # the replay stands beside the town: the same layout, moved sideways off the street by the town's width and a gap
    frame="$(node -e 'const l = require(process.argv[1]), f = l.frame, w = l.extent.z1 - l.extent.z0 + 60; console.log(f.turn ? `${f.ox - w},${f.oz},1` : `${f.ox},${f.oz + w},0`)' "$town/layout.json")"
    tsx scripts/codetown-history-ops.ts "$town" --out "$town-history" --frame "$frame" >> "$LOGS/history.log"
    node "$ROOT/tools/history.mjs" "$town-history" clear --port "$DEV_PORT" >/dev/null
    node "$ROOT/tools/history.mjs" "$town-history" play --port "$DEV_PORT"
    ;;
  stop)
    node "$ROOT/tools/devcli.mjs" quit --port "$DEV_PORT" --timeout 30 >/dev/null 2>&1 && echo "game stopped" || true
    stop_port "$PORT" backend; stop_port "$SCREEN_PORT" "the wall"
    ;;
  status)
    for pair in "backend:$PORT" "game:$DEV_PORT" "wall:$SCREEN_PORT"; do if listening "${pair##*:}"; then echo "${pair%%:*}: running"; else echo "${pair%%:*}: stopped"; fi; done
    ;;
  *) sed -n 3,7p "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
