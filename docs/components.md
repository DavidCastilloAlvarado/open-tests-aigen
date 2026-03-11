# Component Design (Current Code)

Last updated: 2026-03-10

## 1) Frontend component map (React)

The frontend currently uses one main component: `frontend/src/App.tsx`.

### 1.1 Top-level UI modes
1. `Home` mode
   - Provider configuration form (`baseUrl`, `apiKey`, `model`)
   - Save config action
   - Start session action
2. `Test` mode
   - Header with persistent timer and HOME reset control
   - Section status card
   - Loading/progress card while generating/analyzing
   - Two-pane test layout:
     - left: section stimulus (reading/listening/speaking/writing)
     - right: question + response controls
   - Final report card after completion

### 1.2 Implemented section-specific views
- Reading view
  - passage rendering
  - question type + options
- Listening view
  - chunked audio playback controls
  - chunk metadata display (voice/gender)
  - transcript toggle
- Speaking view
  - microphone recording start/stop
  - `Analyze Speaking` action
  - transcript and AI analysis display
  - per-question speaking timer metadata
- Writing view
  - prompt + long-form textarea

### 1.3 Frontend state domains in `App.tsx`
- Config state (`baseUrl`, `apiKey`, `model`, active provider query result)
- Session state (`session`, `sections`, current section/question cursors)
- Task state (`sectionItemsById`, prompt payload parsing)
- Response state (`responsesByItemId`, draft autosave behavior)
- Timing state:
  - section timer for reading/listening/writing
  - per-question timer for speaking
- Audio state:
  - listening playback queue/chunk index
  - speech synthesis fallback state
  - speaking recording blob + recorder lifecycle
- Report state (`finalReport`)

## 2) Backend component map (NestJS)

### 2.1 Controllers
- `HealthController` (`GET /health`)
- `AudioController` (`GET /audio/:fileName`)
- `SpeechController` (`POST /speech/analyze`)

### 2.2 GraphQL layer
- `SessionResolver`
  - provider config mutations/queries
  - session lifecycle mutations/queries
  - task generation (`nextTask`)
  - answer save
  - report generation

### 2.3 Core services
- `ProviderConfigService`
  - stores encrypted provider credentials
  - returns masked active config
  - lightweight connection check (non-empty fields)
- `SessionService`
  - ensures default blueprint
  - starts/completes sessions
  - saves answers (replace-by-item behavior)
- `GenerationService`
  - creates context-aware tasks
  - enforces reading/listening blueprints
  - generates listening audio/chunks
  - enriches prompt payload metadata
- `SpeechAnalysisService`
  - transcribes uploaded speaking audio via fallback endpoint strategy
  - analyzes transcript using chat completions
- `ReportService`
  - produces heuristic report JSON and overall scores
- `CryptoService`
  - API key encryption/decryption/masking

## 3) Cross-cutting infrastructure

1. Prisma ORM (`PrismaService`) for all persistence access.
2. GraphQL JSON scalar for flexible payload fields.
3. Dockerized services (`api`, `frontend`, `postgres`, `redis`, `worker`).
4. Worker process exists but currently runs placeholder heartbeat logic only.

## 4) Interaction examples

### 4.1 Start and run a section
1. Frontend calls `startSession`.
2. `SessionService` creates section rows from blueprint.
3. Frontend calls `nextTask`.
4. `GenerationService` builds context from prior items/answers and persists `generation_context_snapshot`.
5. Generated item is rendered and answers are saved through `saveAnswer`.

### 4.2 Speaking analysis
1. Frontend records audio with `MediaRecorder`.
2. Frontend posts multipart form to `/speech/analyze`.
3. `SpeechAnalysisService` transcribes audio (explicit endpoint -> Azure deployment endpoint -> OpenAI-compatible fallback).
4. Service requests transcript analysis from chat completion endpoint.
5. Frontend displays transcript + feedback and reuses transcript as answer text.

## 5) Current gaps

1. No dedicated route/page component split yet (single `App.tsx` orchestration).
2. No background job orchestration through Redis/BullMQ yet.
3. No PDF export component/service yet.
4. No authentication/authorization layer.
