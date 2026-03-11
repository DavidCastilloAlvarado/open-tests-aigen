# TOEFL 2026 Reading + Listening Blueprint (Simulator Implementation)

Last updated: 2026-03-10

## 1) Why this blueprint exists

The simulator now generates **full question sets** for Reading and Listening instead of single isolated questions.

- Reading set = **1 academic passage + 10 questions**
- Listening set = **1 lecture + 1 conversation + 11 questions total**

This keeps item flow closer to official TOEFL-style task design while preserving the project rule: generated content must be original.

## 2) Research basis (public ETS pages)

### Reading
- ETS Reading section page states:
  - 2 passages
  - each ~700 words
  - 10 questions per passage
- Source: https://www.ets.org/toefl/test-takers/ibt/about/content/reading.html

Question families listed by ETS Reading materials:
- factual / negative factual
- inference / rhetorical purpose
- vocabulary
- sentence simplification
- insert text
- prose summary

### Listening
- ETS Listening section page states:
  - 3 lectures (3-5 min), 6 questions each
  - 2 conversations (3 min), 5 questions each
- Source: https://www.ets.org/toefl/test-takers/ibt/about/content/listening.html

Question families listed by ETS Listening materials:
- gist-content / gist-purpose
- detail
- function
- attitude
- organization
- connecting content
- inference

### 2026 adaptation note
- ETS public 2026 materials indicate adaptivity and revised task framing, but the fully deterministic item-count matrix is not fully published in machine-readable detail.
- In this simulator, we enforce a fixed, transparent blueprint for quality control and repeatability.

## 3) Implemented Reading question-type strategy (10 items)

For `Read an Academic Passage` tasks, the simulator uses this fixed sequence:

| Order | Question type |
|---|---|
| 1 | factual_information |
| 2 | negative_factual_information |
| 3 | inference |
| 4 | rhetorical_purpose |
| 5 | vocabulary_in_context |
| 6 | vocabulary_in_context |
| 7 | sentence_simplification |
| 8 | insert_text |
| 9 | detail |
| 10 | prose_summary |

Stimulus constraints:
- 620-780 words
- university textbook-like expository style
- B2-C1 academic vocabulary with context clues
- topic domains biased toward science/social-science/humanities university content

## 4) Implemented Listening question-type strategy (11 items)

For Listening, one set contains **two stimuli**:

1. Academic lecture (6 questions)
2. Campus conversation (5 questions)

### Lecture distribution (6)
1. gist_content
2. detail
3. detail
4. organization
5. attitude
6. connecting_content

### Conversation distribution (5)
1. gist_purpose
2. detail
3. function
4. inference
5. attitude

Stimulus constraints:
- Lecture transcript: 420-760 words
- Conversation transcript: 320-520 words
- Spoken academic/campus tone with discourse markers and implied meaning

## 5) Audio generation strategy (Listening)

The backend now generates chunked listening audio with persistent voice profiles per actor.

Priority:
1. Split lecture/conversation transcript into multiple chunks.
2. Generate one audio file per chunk via OpenAI-compatible `POST /audio/speech` with:
   - model: `gpt-4o-mini-tts` (default)
   - voice: selected once per actor (lecture narrator, student, advisor/professor, etc.) and persisted across that full stimulus
   - input: clean chunk text (speaker labels removed from spoken text)
   - instructions: chunk-specific intonation/tone instructions
3. Save each MP3 under runtime storage and expose with backend route `/audio/:fileName`.
4. Store ordered chunk metadata in `promptPayload.audioChunks`.
5. Frontend reproduces chunk audios sequentially (no server-side merge required).

Voice selection rule:
- Within one lecture stimulus (single speaker), one random voice is selected and reused for all chunks.
- Within one conversation stimulus, each actor gets one random voice and keeps it through all turns/chunks.
- Randomness happens between generated tests/stimuli, not inside a single actor's continuity.
- Voices are constrained to American-English voice profiles.

Each chunk includes metadata such as:
- `sequence`
- `audioUrl`
- `voice`
- `gender`
- `speakerRole`
- `instructions`

## 6) Code mapping

- Reading/listening set generation and distribution enforcement:
  - `backend/src/services/generation.service.ts`
- Audio file streaming route:
  - `backend/src/audio.controller.ts`
- Frontend section limits and question meta rendering:
  - `frontend/src/App.tsx`

## 7) Related speaking implementation notes (cross-section consistency)

Even though this file is reading/listening focused, the current simulator now aligns speaking timing behavior with per-question control:

1. Speaking prompt payloads include:
   - `preparationTimeSeconds`
   - `responseTimeSeconds`
   - `speakingTimeLimitSeconds`
2. Frontend uses those payload values for per-question countdowns in the speaking section.
3. Speaking responses can be recorded/analyzed through `POST /speech/analyze`, and transcript output can be reused as the answer text draft.

Primary code paths:
- `backend/src/services/generation.service.ts` (speaking prompt timing metadata)
- `backend/src/services/speech-analysis.service.ts` (transcription + analysis fallback logic)
- `frontend/src/App.tsx` (speaking timer + recording/analyze controls)

## 8) Known limitations / next refinements

1. Current simulator uses one Reading stimulus set and one Listening set per section for deterministic flow.
2. True 2026 adaptive branching can later select among multiple pre-generated sets by difficulty/performance.
3. If ETS publishes stricter 2026 task-count matrices, update this blueprint constants first, then prompt contracts.
4. Official speaking prep/response splits are still configurable assumptions and should be updated when ETS publishes clearer timing tables.
