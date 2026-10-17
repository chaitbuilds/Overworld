# Overworld

**Watch AI build your codebase.**

![A street in Overworld. Every building is a folder of the codebase.](docs/town.jpg)

Overworld turns a git repository into a town you can walk through in Minecraft. Every building is a folder of real
code. Walk up to one, ask for a change, and AI agents build it inside, where you can watch. Pull the lever, and your
real app, running on the town square's wall, changes.

## What it does

- **Maps any repository into a town.** One building per module, sized by its lines of code, lined up along the street
  by what depends on what. Nothing is laid out by hand.
- **Grows it from your history.** Replay the commits and watch the town rise from the first one.
- **Takes requests where the code lives.** Hold a sign, aim it at a building or a quarter's gate, and type.
- **Shows the agents at work.** A lead agent plans. In each building one agent writes failing tests and another writes
  the change, while a screen inside shows the code being written. A new module gets a new building, which rises as its
  code is written.
- **Leaves the merge to you.** When every check passes, pull the lever. The change is merged into the branch you have
  checked out; nothing is pushed.
- **Shows your app on the wall.** Point the wall at your dev server and see the change in the real product.

## Run it

You need Java 25, Node 22+, git and Minecraft: Java Edition. Agents run on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) with an `ANTHROPIC_API_KEY`
(or your own Claude login: `OVERWORLD_BACKEND_ARGS=--use-claude-login`).

```sh
npm install --prefix foreman
npx --prefix foreman playwright install chromium  # only for the wall

tools/overworld.sh start ~/code/my-app            # map the repo, open the town
tools/overworld.sh start ~/code/my-app --agents   # the same, and requests run AI agents
tools/overworld.sh wall http://localhost:3000     # your app on the square's wall
tools/overworld.sh history                        # watch the town grow from its first commit
tools/overworld.sh stop
```

## How it works

| Folder | |
|---|---|
| `foreman/` | Maps the repository, runs the agents in their own git worktrees, runs your CI, merges |
| `mod/` | The Fabric mod: the town, the requests, the agents, the lever and the wall |
| `tools/` | The launcher, the live wall and the history replay |

Agents have no shell and no network. Each one reads and writes only inside its own worktree, and your repository
changes only when you pull the lever.

## License

MIT
