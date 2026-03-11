# TOEFL 2026 Open Questions (Need Confirmation)

Last updated: 2026-03-10

These are the remaining gaps for strict parity with the latest TOEFL 2026 implementation.

## A) Timing and counts
1. What exact per-section timers should we enforce for 2026 forms under adaptive delivery?
2. What are the minimum/maximum item counts per section in adaptive mode?
3. Are timing/count values fixed by section, or dynamically selected per test path?
4. For speaking tasks, what are official prep/response splits by task subtype (if they differ)?

Current simulator note:
- Speaking is now timed per question in UI (`preparationTimeSeconds` + `responseTimeSeconds`), but official 2026 values are still configurable assumptions.

## B) Task mapping
From ETS public page, these task names are visible:
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

Need confirmation on:
1. Exact section assignment for each task label.
2. Mandatory vs optional tasks in a single full test.
3. Task order constraints (fixed order vs adaptive order).
4. Whether any task labels are grouped/renamed in production forms vs marketing descriptions.

## C) Scoring output
1. Should we show only 1-6 in UI, or both 1-6 and comparable 0-120 in all report screens?
2. For speaking/writing AI scoring rubrics, should we align strictly to CEFR descriptor language in ETS guidance?
3. Which analytic dimensions should be mandatory in speaking feedback to best mirror TOEFL expectations?

## D) Product wording
1. Confirm final wording in UI/footer:
   - "TOEFL-like simulator. Not affiliated with ETS."
2. Confirm if you want this disclaimer on start page, report page, and exported PDF.

## E) Technical integration questions
1. Should provider connection testing remain lightweight (field presence), or should we add a real API probe before save?
2. Should speaking transcription be hard-bound to Azure deployment env vars, or continue using multi-endpoint fallback mode?
3. Do we want to persist speaking transcript/analysis artifacts as first-class DB entities beyond answer payload text?
