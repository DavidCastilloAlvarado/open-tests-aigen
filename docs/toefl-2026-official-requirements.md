# TOEFL iBT 2026 Official Requirements (Implementation Notes)

Last updated: 2026-03-10
Scope: requirements from official ETS pages + how the current simulator maps to them.

## 1) Authoritative sources used

1. ETS TOEFL iBT test content and structure
   - https://www.ets.org/toefl/test-takers/ibt/about/content.html
   - Mirror route with same content: https://www.ets.org/toefl/institutions/ibt/about/content-structure.html
2. ETS TOEFL score guidance (January 2026 changes)
   - https://www.ets.org/toefl/test-takers/ibt/scores/understand-scores.html
3. ETS score-scale update (institution guide)
   - https://www.ets.org/toefl/china/toefl/score-scale-update.html
4. ETS press release (transformation announcement)
   - https://www.ets.org/news/press-releases/toefl-transformation-announcement.html

## 2) Confirmed official 2026 requirements

### 2.1 Overall structure
- TOEFL iBT has 4 sections:
  - Reading
  - Listening
  - Speaking
  - Writing
- Official page states approximately 2 hours total test time.
- Official note: because test is adaptive, time and items may vary.

### 2.2 New/updated task families shown by ETS content page
The official content page lists these task labels:
- Complete the Words
- Read in Daily Life
- Read an Academic Passage
- Listen and Choose a Response
- Listen to a Conversation
- Listen to an Announcement
- Listen to an Academic Talk
- Build a Sentence
- Write an Email
- Write for an Academic Discussion
- Listen and Repeat
- Take an Interview

### 2.3 Adaptivity
- ETS indicates a multistage adaptive design for Reading and Listening beginning January 2026.

### 2.4 Scoring
- New score scale from January 21, 2026:
  - Section scores and overall score on 1-6 scale in 0.5 increments.
- Overall score calculation:
  - Average of the 4 section scores.
  - Rounded to nearest half band.
- Transition period:
  - ETS indicates a two-year transition where comparable 0-120 reporting is also provided.

### 2.5 CEFR alignment
- ETS states the new 1-6 score design aligns more directly with CEFR interpretation.
- ETS institution page includes performance descriptors aligned to CEFR ranges.

## 3) Product implications for this project

1. Simulate TOEFL-like flow and timing constraints, but do not copy ETS proprietary UI/assets/text.
2. Keep 4 sections and enforce timed progression.
3. Implement Reading/Listening adaptive branching logic.
4. Score output should include:
   - 1-6 per section
   - overall 1-6 (nearest half-band)
   - optional comparable 0-120 estimate for transition reporting
5. Reporting should include CEFR-linked interpretation and improvement actions.

## 4) Current implementation mapping (as of now)

1. **4-section flow implemented**
   - Reading, Listening, Speaking, Writing sections are created from blueprint `toefl_ibt_2026_v1`.
2. **Reading/Listening structure implemented with fixed transparent blueprint**
   - Reading: fixed 48-item path using Complete the Words, Read in Daily Life, and short Academic Passage blocks.
   - Listening: 11-question bundle (lecture + conversation) with fixed type distribution.
3. **Speaking timing behavior updated**
   - Simulator now enforces speaking time **per question** in frontend using:
     - `preparationTimeSeconds`
     - `responseTimeSeconds`
     - `speakingTimeLimitSeconds`
   - Timeout auto-saves and advances to next speaking task.
4. **Speaking analyze pipeline implemented**
   - Frontend records audio and posts multipart form to `POST /speech/analyze`.
   - Backend transcribes via fallback endpoint strategy (explicit endpoint -> Azure deployment endpoint -> OpenAI-compatible endpoint) and generates analysis feedback.
5. **Scoring/reporting currently heuristic**
   - Report uses defaulted section scores where missing and computes 1-6 + estimated 0-120.
   - Not yet a full rubric-faithful TOEFL scoring engine.

## 5) Compliance and copyright boundary

- Allowed:
  - Original AI-generated items that match public structure and skills.
  - Similar test flow.
- Not allowed:
  - Reproducing real ETS test questions.
  - Pixel-identical copying of official UX or branding.

## 6) Known ambiguities to confirm before hard-coding

The scraped ETS content route does not expose a reliable machine-readable timing table in this environment. We should confirm before hard-locking exact values in code:

1. Exact per-section time windows for 2026 forms.
2. Exact item-count ranges by section under adaptive delivery.
3. Exact task-to-section mapping for all 12 listed task labels.
4. Whether all 12 task labels are always present in one exam instance or represent a task pool.

## 7) Recommended implementation policy

Until ambiguous points are confirmed:
1. Keep timings and item ranges in configurable DB settings.
2. Version the exam blueprint (e.g., `toefl_ibt_2026_v1`).
3. Mark reports as "TOEFL-like simulation based on public ETS format guidance".

## 8) Current simulator blueprint snapshot (implemented)

For the current codebase implementation details, see:

- `docs/toefl-2026-reading-listening-blueprint.md`

Highlights:
1. Reading now generates a fixed 48-item TOEFL 2026-style path with deterministic block order and question-type coverage.
2. Listening now generates 1 lecture (6 questions) + 1 conversation (5 questions) with explicit type distribution.
3. Listening stimuli are accompanied by generated/returned audio URLs for playable items.
4. Speaking question payloads now include per-question timing metadata consumed by frontend timers.
