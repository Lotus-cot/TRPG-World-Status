# TRPG World Status

TRPG World Status is a web-based narrative processing tool for converting
English prose into a structured tabletop role-playing game world state.

The v2 pipeline processes English from end to end. For James Joyce's *The
Dead*, it loads a fixed 26-entity character registry with stable ids, retrieves
only candidates from that closed literary knowledge base, and uses the ReLiK
Reader without its Wikipedia index. DeepSeek resolves only ambiguous titles or
conflicting links. Maverick LitBank expands pronouns and nominal references in
bounded windows, after which local clusters are merged by stable character id.
DeepSeek then receives the English source plus the authoritative character
context and produces an English World Status JSON.

This project is intended as an experimental digital humanities and interactive
narrative prototype. It explores how NLP and large language models can support
the transformation of literary narrative into playable TRPG-oriented world
structures.

## Combined Literary TRPG System

This repository is the **adaptation and browser layer** of a two-repository
system. It converts literary prose into a playable World Status JSON and
provides the designer/player interface. The companion
[`aether-poem/event_generator`](https://github.com/aether-poem/event_generator)
repository is the **authoritative runtime layer**: it owns sessions, dice,
committed events, world-state versions, QQ chat bindings, and the immutable
session ledger.

```text
Literary source
  -> character analysis and World Status generation (this repository)
  -> validated World Status JSON
  -> authoritative session (event_generator)
  -> browser actions or QQ commands
  -> deterministic dice adjudication
  -> committed event and new world-state version
  -> browser/QQ presentation
```

The browser and QQ are two clients of the same runtime session. They are not
separate games. The browser is used to build/import the module, start a session,
inspect the literary structure, and export artifacts. QQ is used as a familiar
group-play interface. Only `event_generator` is allowed to commit authoritative
state changes.

### Component map

| Component | Default address | Responsibility |
| --- | --- | --- |
| World Status FastAPI app | `http://127.0.0.1:8000` | Text intake, character pipeline, World Status JSON, graph, acts, browser game UI, exports |
| Event Generator runtime | `http://127.0.0.1:8080` | Session creation, rules, dice, event commits, state versions, persistence |
| NapCat OneBot server | `ws://127.0.0.1:3001` | QQ login and bidirectional QQ transport |
| NapCat WebUI | `http://127.0.0.1:6099` | QQ/NapCat login and network configuration |
| World Status QQ adapter | background process | Converts explicit `.ws` commands into runtime API calls and returns replies |
| SQLite runtime store | `WORLD_STATUS_DATA_DIR` | Sessions, pair codes, channel bindings, participants, messages, and imported rolls |

## Combined Local Quick Start

### 1. Place the repositories together

The Windows launcher expects the repositories to be siblings. The optional
NapCat directory and runtime data can live beside them:

```text
E:\AllenNLP\
|-- backend\                 # this repository
|-- eventgenerator\          # aether-poem/event_generator
|-- NapCatQQ\                # optional local NapCat/QQ installation
`-- runtime-data\            # generated SQLite data and logs
```

Clone both source repositories:

```powershell
git clone https://github.com/aether-poem/TRPG-World-Status.git E:\AllenNLP\backend
git clone https://github.com/aether-poem/event_generator.git E:\AllenNLP\eventgenerator
```

### 2. Install both applications

```powershell
cd E:\AllenNLP\backend
python -m pip install -r requirements.txt

cd E:\AllenNLP\eventgenerator
python -m pip install -e ".[dev]"
```

ReLiK and Maverick are optional local model stages. Install
`requirements-character-pipeline.txt` only on a machine with enough memory.
The deterministic runtime and QQ command path do not require those model
weights.

### 3. Configure local secrets

Use environment variables or untracked `.env` files. Never commit real keys or
OneBot tokens.

```powershell
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "your-key", "User")
[Environment]::SetEnvironmentVariable("WORLD_STATUS_DATA_DIR", "E:\AllenNLP\runtime-data", "User")
[Environment]::SetEnvironmentVariable("WORLD_STATUS_RUNTIME_API", "http://127.0.0.1:8080", "User")
[Environment]::SetEnvironmentVariable("WORLDS_QQ_WS_URL", "ws://127.0.0.1:3001", "User")
[Environment]::SetEnvironmentVariable("WORLDS_QQ_ONEBOT_TOKEN", "a-long-random-token", "User")
```

Configure the same OneBot token in NapCat's WebSocket server. NapCat and QQ
binaries are deliberately not included in either repository; obtain them from
the official NapCat project and comply with QQ/NapCat terms and security
guidance.

### 4. Start the combined stack

From this repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_combined_stack.ps1
```

The launcher starts the runtime on port `8080`, this FastAPI app on port `8000`,
the QQ adapter when a OneBot token is configured, and an adjacent local NapCat
launcher when present. Logs and the SQLite session database are written under
`WORLD_STATUS_DATA_DIR`.

Individual development commands remain available:

```powershell
# terminal 1: authoritative runtime
cd E:\AllenNLP\eventgenerator
python run_server.py --host 127.0.0.1 --port 8080 --seed 2026

# terminal 2: World Status web app
cd E:\AllenNLP\backend
python -m uvicorn app:app --host 127.0.0.1 --port 8000

# terminal 3: QQ adapter
cd E:\AllenNLP\eventgenerator
python -m src.qq_adapter_cli
```

## Browser-to-QQ Play Workflow

1. Open `http://127.0.0.1:8000/`.
2. Paste/upload English literary prose and generate a World Status, or import a
   previously exported World Status JSON.
3. In **Solo Session**, choose a player character and select **Start New Solo
   Session**.
4. In **QQ Play Bridge**, copy the six-digit pairing code.
5. In the target QQ group or private chat, send `.ws bind 123456` with the real
   code.
6. Each player sends `.ws pc Character Name` from their own QQ account.
7. Query the scene with `.ws scene`, request ideas with `.ws idea`, and commit an
   action with `.ws act <action description>`.
8. Export the browser session or ledger when the run ends.

The pairing code links a QQ channel to one runtime session. Creating a new code
invalidates the previous code. Rebinding the same QQ channel to another session
replaces its prior channel binding.

### QQ commands

| Command | Result | Commits world state? |
| --- | --- | --- |
| `.ws help` | List commands | No |
| `.ws ping` | Check adapter connectivity | No |
| `.ws bind <six-digit code>` | Link the current chat to a runtime session | Binding only |
| `.ws pc <character name>` | Bind the sender to a module character | Participant binding only |
| `.ws scene` | Show current scene and state version | No |
| `.ws idea [general/investigate/social/bold]` | Return three state-conditioned ideas | No |
| `.ws act <action>` | Roll, adjudicate, commit an event, and advance state version | **Yes** |
| `.ws state` | Show compact authoritative state | No |
| `.ws recap` | Show a compact session recap | No |
| `.ws players` | List QQ participant bindings | No |

The aliases `.world` and `.世界` are also accepted. Ordinary group chat is
ignored by the current adapter. This explicit-command boundary prevents casual
conversation from accidentally changing the game world.

## Authority And Synchronization

- The World Status JSON is the module snapshot used to create a session.
- The Event Generator runtime is the source of truth after session creation.
- Every committed action carries an expected state version. Stale clients are
  rejected instead of silently overwriting newer events.
- AI may propose ideas or rewrite narration, but it cannot override dice,
  validation, or committed effects.
- Browser `localStorage` is a presentation and recovery cache, not the
  authoritative multiplayer database.
- The browser currently refreshes QQ connection, participant, binding, and
  runtime-version metadata. A QQ action is authoritative immediately, although
  the browser's local visual ledger does not yet replay every remote QQ event.

## Local And Netlify Boundaries

The Netlify deployment is a public generation/demo surface. It can generate
World Status JSON and serve browser assets, but it cannot host local ReLiK or
Maverick weights, a persistent desktop QQ login, NapCat, or the local SQLite
runtime. The complete browser + authoritative runtime + QQ loop is therefore a
local deployment in the current version.

## Features

- Browser-based interface for entering or loading narrative text.
- Browser-local snapshot save/load for generated results.
- Manual export of the full result as JSON and the coreference result as TXT.
- Clickable ontology-layer filters for micro, meso, macro, context, and full JSON views.
- Interactive knowledge graph generated from the same World Status JSON.
- Browser-local solo play loop with character selection, checks, scene progress,
  state changes, endings, and exportable session logs.
- Optional DeepSeek turn narration that cannot override local dice adjudication.
- Local sentence chunking with a custom tokenizer.
- ReLiK Reader linking against the closed *The Dead* registry, without a
  Wikipedia entity index.
- DeepSeek validation limited to ambiguous mentions and local context.
- Optional Maverick LitBank window coreference expansion.
- Transparent deterministic English fallbacks when local models are unavailable.
- DeepSeek-powered TRPG world-state generation.
- Three-layer ontology-oriented output for digital humanities interpretation.
- Side-by-side display of:
  - original text,
  - coreference-annotated English text,
  - generated world-state JSON.
- FastAPI backend with a simple JSON API.

## System Architecture

```text
Browser UI
  |
  | POST /api/world-state
  v
FastAPI backend
  |
  v
The Dead fixed character registry and stable ids
  |
  v
Closed-registry candidate retrieval + exact aliases
  |
  v
ReLiK Reader span linking (no Wikipedia index)
  |
  v
DeepSeek ambiguity resolution
  |
  v
Maverick LitBank window expansion (optional)
  |
  v
Stable-id cross-window cluster merge
  |
  v
DeepSeek Chat Completions API
  |
  v
Structured TRPG world-state JSON
```

## Ontology-Oriented Output

The generated JSON keeps the original practical field structure, but its
meaning is aligned with a three-layer narrative ontology:

| Layer | JSON fields | Ontology reading | Interpretation value |
| --- | --- | --- | --- |
| Micro | `characters`, `items` | `Character`, `NarrativeObject / Clue`, `hasOwner`, `evokesMemory` | Character psychology, local interaction, symbolic objects, and clues. |
| Meso | `locations`, `factions`, `relationships` | `Place`, `CollectiveAgent`, `hasSocialRelationWith`, `belongsToCollective` | Social relations, group positions, spatial narrative, and faction pressure. |
| Macro | `timeline`, `quests`, `open_threads` | `NarrativeEvent`, `Quest`, `OpenThread`, `precedes`, `containsQuest` | Plot progression, task generation, and world-state evolution. |

`context_variables.atmosphere` and `context_variables.scene_state` are treated
as global contextual constraints rather than ordinary concept classes. They
describe the scene tone, psychological pressure, thematic atmosphere, and the
overall current condition of the adapted scenario.

Several ontology object properties are inferred from existing fields without
requiring extra JSON fields:

- `items.owner` -> `hasOwner`
- `items.importance` and `timeline` -> `evokesMemory`
- `factions.relationships` and `characters.description` -> `belongsToCollective`
- `timeline` order -> `precedes`
- `quests` and `open_threads` -> `containsQuest`

The browser interface exposes these layers as clickable filters:

- Micro view: `characters`, `items`
- Meso view: `locations`, `factions`, `relationships`
- Macro view: `timeline`, `quests`, `open_threads`
- Context view: `context_variables`
- Full JSON view: the complete generated world state

Filtering changes only the visible and copied JSON. Snapshot saving and JSON
downloads always preserve the complete world-state result.

## Interactive Knowledge Graph

The browser turns each generated or imported World Status JSON into an
interactive SVG knowledge graph without changing the backend JSON contract.
Designers can:

- drag nodes and pan or zoom the graph,
- search across node names and attributes,
- filter characters, locations, factions, items, events, quests, open threads,
  context, and externally referenced entities,
- click a node to inspect all of its World Status fields,
- import a previously downloaded World Status snapshot JSON,
- export a static SVG or a self-contained interactive HTML file.

Explicit `relationships` become graph edges, `items.owner` becomes an ownership
edge, and adjacent `timeline` entries are connected in sequence. The graph also
keeps a World Status root node so entities that do not yet have explicit
relationships remain discoverable.

The interactive HTML export can be opened directly in a modern browser without
the backend or an internet connection. It preserves search, type filters,
zooming, panning, node dragging, and the node detail panel.

## Solo Play Loop

After generating or importing a World Status JSON, the browser can create a
single-player session from its characters and scenes. The runtime is local and
failure-forward: each action rolls `1d20`, applies character and scene
modifiers, produces a structured outcome, updates clues, relationships,
pressure, quest progress, and ending progress, then appends an auditable event
to the session log.

The session is saved in browser `localStorage` and can be exported or imported
as JSON. Logs can also be exported as Markdown. Scene progression and ending
selection remain available without a network connection. When
`/api/narrate-turn` is available, DeepSeek may rewrite the already-adjudicated
result as literary narration and suggest possible next actions; it cannot alter
the roll, effects, or saved state. If narration fails, the local result remains
playable and saved.

## Technology Stack

- Python 3.12
- FastAPI
- Uvicorn
- ReLiK (optional local inference)
- Maverick Coref with the LitBank checkpoint (optional local inference)
- DeepSeek Chat Completions API for ambiguity resolution and world generation
- HTML, CSS, and vanilla JavaScript

## Netlify Deployment

The repository includes `netlify.toml` and lightweight Netlify Functions for a
production-hosted version:

```bash
netlify env:set DEEPSEEK_API_KEY your-key
netlify deploy --prod
```

Netlify cannot host ReLiK or Maverick model weights. The cloud build
uses English alias linking and labels the unavailable stages explicitly in
`character_resolution`. The local FastAPI workflow exposes the complete model
adapter chain. Both deployments preserve the same English JSON contract,
detailed acts, interactive graph, and export formats.

Confirmed local environment versions:

```text
FastAPI 0.120.0
Uvicorn 0.38.0
Pydantic 2.8.2
spaCy 3.7.2
Python 3.12.7
ReLiK 1.0.6
Maverick Coref 1.0.7
PyTorch 2.8.0 (CPU)
Transformers 4.41.2
```

## Repository Structure

```text
.
|-- app.py
|-- pipeline.py
|-- requirements.txt
|-- requirements-character-pipeline.txt
|-- frontend/
|   |-- index.html
|   |-- styles.css
|   |-- app.js
|   |-- game.js
|   |-- graph.js
|   `-- world-state-client.js
|-- utils/
|   |-- character_pipeline.py
|   |-- text_processor.py
|   `-- llm_engine.py
|-- scripts/
|   |-- download_spanbert.sh
|   `-- check_spanbert.py
`-- data/
    `-- .gitkeep
```

The `data/` directory is intentionally empty in the repository. Large model
files, local text data, generated outputs, and API keys are not committed.

Browser snapshots are stored with `localStorage`. They remain in the current
browser only, are not uploaded to the server, and do not call DeepSeek again
when loaded.

## Character Pipeline Modes

The base installation always runs. Every stage reports `ready`, `fallback`,
`partial`, or `unavailable` in the response instead of silently pretending that
a missing model ran successfully.

| Stage | Base installation | Full local installation |
| --- | --- | --- |
| Character roster | Fixed *The Dead* registry or a provided roster | Same |
| Explicit linking | Case-insensitive registry aliases | Registry aliases plus ReLiK Reader |
| Link validation | Deterministic high-confidence validation | DeepSeek closed-candidate resolution |
| Coreference expansion | No speculative pronoun expansion | Maverick LitBank windows |
| Window merge | Stable character-id union | Stable character-id union |

The verified Windows installation runs on CPU. A complete short-text inference
used about 5.3 GB resident memory and took about 63 seconds from a cold process.
Allocate at least 8 GB free system memory and use SSD storage. A CUDA GPU remains
useful for larger books, but it is not required for the installed local path.

Complete results are cached in memory for repeated `(text, chunk size, roster)`
requests. The cache resets when the server restarts.

## Requirements

Base application:

```text
Python 3.9+
4 CPU cores
8 GB RAM
DeepSeek API access
```

Full character inference additionally requires PyTorch, ReLiK, Maverick Coref,
their model weights, and a DeepSeek API key for ambiguous mentions.

## Installation

Create and activate a virtual environment:

```bash
python -m venv trpg_env
source trpg_env/bin/activate
```

Install Python dependencies:

```bash
python -m pip install -r requirements.txt
```

Install the optional character-model adapters only on a machine with suitable
memory and a compatible PyTorch/CUDA stack:

```bash
python -m pip install -r requirements-character-pipeline.txt
```

## DeepSeek Configuration

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Set your own DeepSeek API key:

```env
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_API_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

The repository does not include a real API key. Users must provide their own
key before calling the DeepSeek API.

For backward compatibility, the older misspelled variable name
`DEESEEK_API_KEY` is also supported, but `DEEPSEEK_API_KEY` is preferred.

## Character Model Configuration

Copy `.env.character.example` to `.env.character`. The repository loads this
file after `.env`, allowing model settings to remain separate from API secrets:

```env
CHARACTER_DEFAULT_ROSTER=the_dead
CHARACTER_ROSTER_PATH=data/the_dead_characters.json

CHARACTER_RELIK_ENABLED=1
CHARACTER_RELIK_MODEL=sapienzanlp/relik-entity-linking-small
CHARACTER_RELIK_DEVICE=cpu

CHARACTER_DEEPSEEK_VALIDATION_ENABLED=1
CHARACTER_DEEPSEEK_MAX_CONCURRENCY=2

CHARACTER_MAVERICK_ENABLED=1
CHARACTER_MAVERICK_MODEL=sapienzanlp/maverick-mes-litbank
CHARACTER_MAVERICK_CHECKPOINT=
CHARACTER_MAVERICK_DEVICE=cpu

CHARACTER_WINDOW_WORDS=1200
CHARACTER_WINDOW_OVERLAP_WORDS=150

HF_HOME=D:\WorldStatusNLP\hf-cache
HF_ENDPOINT=https://alpha.hf-mirror.com
```

The local registry is the Retriever side of the adapted architecture: it limits
candidate identity to characters defined for the novel. ReLiK is instantiated
with `retriever=None`, so its bundled Wikipedia index is explicitly ignored;
its Reader chooses among the supplied fictional candidates. Exact alias matches
remain authoritative, while DeepSeek receives only a bounded excerpt and the
closed candidate list for genuinely ambiguous labels such as `Miss Morkan`.
Maverick's LitBank checkpoint then supplies literary coreference clusters, and
BOOKCOREF's stable-identity principle is implemented by merging all windows on
the registry id rather than on surface spelling.

Legacy AllenNLP/SpanBERT files and scripts remain in the repository for
comparison, but v2 does not load them during startup. Install
`requirements-spanbert-legacy.txt` only when reproducing the older pipeline.

## Windows D-Drive Installation And Startup

The verified local installation uses:

```text
D:\WorldStatusNLP\venv
D:\WorldStatusNLP\hf-cache
```

Start the complete local backend from the repository root:

```powershell
.\scripts\start_world_status_windows.ps1
```

The first character request initializes both CPU models and may take roughly a
minute. Later requests in the same server process reuse the loaded models and
the pipeline result cache.

## WSL Location And Startup

Windows users may run the base application directly with Windows Python. WSL2
is recommended for CUDA model adapters because ReLiK, FAISS, PyTorch, and
Maverick generally have a smoother Linux installation path. The existing
launcher exposes the WSL backend at `http://127.0.0.1:8000/`:

```powershell
.\scripts\start_wsl_stack.ps1
```

To run only the backend from inside WSL:

```bash
bash scripts/start_wsl_backend.sh 8001
```

## Running the Web App

Start the FastAPI server:

```bash
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open the local web interface:

```text
http://127.0.0.1:8000
```

For a public cloud demo, bind to all network interfaces:

```bash
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Make sure the server firewall or cloud security group allows access to the
chosen port.

## API Reference

### Health Check

```http
GET /api/health
```

Response:

```json
{
  "status": "ok",
  "language": "en",
  "character_pipeline": {
    "relik": {},
    "deepseek_validation": {},
    "maverick": {}
  }
}
```

### Generate World State

```http
POST /api/world-state
```

Request body:

```json
{
  "text": "Alice saw Bob. She waved to him.",
  "max_chars": 1200,
  "character_names": ["Alice", "Bob"]
}
```

Response fields:

```json
{
  "language": "en",
  "source_text": "...",
  "input_chunks": [],
  "resolved_chunks": [],
  "resolved_text": "...",
  "character_resolution": {
    "characters": [],
    "stages": []
  },
  "world_state": {},
  "model": "deepseek-v4-flash",
  "usage": {}
}
```

The `world_state` object is generated by DeepSeek and is expected to contain:

```text
summary
acts
  act_number
  title
  dramatic_purpose
  opening_state
  scenes
    title
    location
    time
    participants
    objective
    beats
    conflict
    discoveries
    player_choices
    consequences
    transition
  character_changes
  clues_revealed
  unresolved_threads
  closing_state
  next_act_hook
characters
locations
factions
items
relationships
timeline
quests
open_threads
context_variables
  atmosphere
  scene_state
```

The frontend renders `acts` as a dedicated act-and-scene view. Each act captures
its dramatic purpose and state transition, while each scene provides concrete
beats, discoveries, player choices, and consequences for play.

For backward compatibility, if the model returns legacy top-level `atmosphere`
or `scene_state` fields, the backend normalizes them into
`context_variables`.

## Example Character Resolution

Input:

```text
Alice saw Bob. She waved to him.
```

Character clusters:

```json
{
  "Alice": ["Alice", "She"],
  "Bob": ["Bob", "him"]
}
```

When Maverick is enabled, the annotated English text may preserve the original
mention and append its identity, for example `She [Alice]`. The source text is
never overwritten. DeepSeek receives the annotation plus a compact canonical
character registry, which helps associate actions, goals, and relationships
with the correct entities while keeping the entire workflow in English.

## Security Notes

- Do not commit `.env`.
- Do not commit DeepSeek API keys.
- Do not commit local model files or virtual environments.
- This repository includes `.env.example` only.
- Users who deploy the project must provide their own DeepSeek API key.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0.

Noncommercial use is permitted. Commercial use, commercial deployment, resale,
or incorporation into commercial products requires prior permission from the
copyright holder.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

## Limitations

- Coreference resolution is not always correct, especially in long literary
  passages with many characters or ambiguous pronouns.
- The generated world state is LLM output and should be reviewed by a human.
- Optional ReLiK and Maverick models require separate downloads and can load slowly.
- The current system is optimized for English narrative text.
- Netlify uses an explicitly reported alias-only fallback because it cannot host local model weights.

## Intended Use

This project is designed as a research and demonstration prototype for digital
humanities, narrative analysis, and TRPG world-building workflows. It is not a
fully automated literary interpretation system. Human review remains important,
especially when using the generated JSON for scholarly analysis or game design.
