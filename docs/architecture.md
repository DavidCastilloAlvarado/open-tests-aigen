# Open Tests AIGen - System Architecture (Current)

Last updated: 2026-03-10
Scope: single-user TOEFL-like simulator with dynamic generation, listening audio playback, speaking recording/transcription/analysis, and persisted reports.

## 1) Runtime topology

```text
+---------------------+          +-------------------------------+
| React + Vite app    | <------> | NestJS API (GraphQL + REST)  |
| (single page App)   |          |                               |
| - Home config view  |          | - Session resolver            |
| - Test runner view  |          | - GenerationService           |
| - Final report view |          | - SpeechAnalysisService       |
+---------------------+          +---------------+---------------+
                                                 |         |
                                                 |         |
                                   +-------------v--+   +--v----------------+
                                   | PostgreSQL      |   | Redis             |
                                   | Prisma models   |   | provisioned       |
                                   | sessions/items  |   | (queue TBD)       |
                                   +--------+--------+   +-------------------+
                                            |
                                            |
                                  +---------v-------------------+
                                  | OpenAI-compatible provider  |
                                  | chat, audio/speech, transcribe |
                                  +-----------------------------+
```

## 2) API surface in code

### 2.1 GraphQL (`/graphql`)
- Query:
  - `activeProviderConfig`
  - `session(id)`
- Mutations:
  - `saveProviderConfig`
  - `testProviderConnection`
  - `startSession`
  - `nextTask`
  - `saveAnswer`
  - `completeSession`
  - `generateReport`

### 2.2 REST
- `GET /health` -> service status.
- `GET /audio/:fileName` -> streams generated MP3 files.
- `POST /speech/analyze` -> accepts multipart audio + speaking prompt, returns transcript + analysis.

## 3) Current end-to-end flow

### 3.1 Provider setup
1. User enters `baseUrl`, `apiKey`, `model` on Home.
2. Backend encrypts API key and stores a new active `ProviderConfig`.
3. UI uses GraphQL only for provider config/session operations.

### 3.2 Session + task generation
1. `startSession` creates one session with 4 sections from blueprint `toefl_ibt_2026_v1`.
2. `nextTask`:
   - loads existing items and answers,
   - builds `contextPayload` (prior generated items, prior responses, anti-repetition topic hints),
   - persists `generation_context_snapshot`,
   - generates items using provider:
     - Reading blocks: fixed 48-item path across Complete the Words, Read in Daily Life, and Academic Passage tasks
     - Listening bundle: 11 questions (lecture + conversation)
     - Speaking/Writing: single item
3. Backend stores generated items and metadata (`questionType`, `questionIndex`, `questionSetSize`, `stimulusType`, `stimulusGroupId`).
4. Frontend auto-requests next items and autosaves response payloads.

### 3.3 Timing behavior
- Reading/Listening/Writing: section-level countdown from `section.timeLimitSeconds`.
- Speaking: per-question countdown from prompt payload:
  - `preparationTimeSeconds`
  - `responseTimeSeconds`
  - `speakingTimeLimitSeconds`
- On speaking timeout, frontend auto-stops recording (if active), saves answer, and advances to next task.

### 3.4 Listening audio behavior
- Backend tries chunked TTS generation using `/audio/speech`.
- Stores chunk metadata in `promptPayload.audioChunks`.
- Preserves one voice per actor within a stimulus (lecture narrator, conversation roles).
- Strips speaker labels from spoken chunk text.
- Frontend auto-plays chunk sequence and can toggle transcript visibility.

### 3.5 Speaking analysis behavior
1. Frontend records audio via `MediaRecorder`.
2. Frontend sends multipart request to `/speech/analyze`.
3. Backend transcription endpoint resolution tries:
   - explicit `AZURE_OPENAI_TRANSCRIBE_ENDPOINT` / `SPEECH_TRANSCRIBE_ENDPOINT`,
   - Azure deployment endpoint using `AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT` + `AZURE_OPENAI_API_VERSION`,
   - OpenAI-compatible `/audio/transcriptions` fallback.
4. Backend then analyzes transcript with chat completion model from active config.
5. Frontend displays transcript + AI analysis and copies transcript into text answer box.

## 4) Persistence model summary

- `ProviderConfig`: encrypted provider credentials.
- `ExamBlueprint`: section config JSON.
- `TestSession` + `SectionInstance`: test lifecycle and per-section timing.
- `TestItem`: generated prompts and metadata.
- `Answer`: latest answer per item (current save flow replaces prior entries for same item).
- `GenerationContextSnapshot`: audit trail for generation context.
- `AnalysisReport`: persisted final report JSON.
- `SessionEvent`: lifecycle and answer-save/task-generated events.

## 5) Environment/config notes

Important runtime variables currently used:
- Core: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `GRAPHQL_PORT`
- Frontend integration: `VITE_GRAPHQL_URL`, `VITE_API_BASE_URL`, `PUBLIC_API_BASE_URL`
- TTS: `TTS_MODEL`, `TTS_VOICE`, `TTS_INSTRUCTIONS`, `AUDIO_STORAGE_DIR`
- Speaking transcription: `SPEECH_TRANSCRIPTION_MODEL`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT`, `AZURE_OPENAI_TRANSCRIBE_ENDPOINT`

## 6) Current limitations (important)

1. Worker is still a placeholder heartbeat loop; no BullMQ processing yet.
2. `testProviderConnection` currently validates non-empty fields only.
3. Report scoring is heuristic/defaulted (not full TOEFL rubric scoring).
4. Section records still store section-level speaking time (`1020s`), while UI enforces per-question speaking timers from prompt payload.
5. No auth layer yet (single-user local usage assumption).
