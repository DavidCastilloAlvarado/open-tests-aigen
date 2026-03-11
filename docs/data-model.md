# Data Model (Current Prisma Schema)

Last updated: 2026-03-10
Source of truth: `backend/prisma/schema.prisma`

## 1) Enums

1. `SessionStatus`
   - `STARTED`
   - `IN_PROGRESS`
   - `COMPLETED`
   - `CANCELED`
2. `SectionType`
   - `READING`
   - `LISTENING`
   - `SPEAKING`
   - `WRITING`

## 2) Models

### 2.1 `ProviderConfig`
- `id: String @id @default(uuid())`
- `baseUrl: String`
- `model: String`
- `apiKeyEncrypted: String`
- `isActive: Boolean @default(true)`
- `createdAt`, `updatedAt`

### 2.2 `ExamBlueprint`
- `id: String @id @default(uuid())`
- `code: String @unique` (default used in app: `toefl_ibt_2026_v1`)
- `isActive: Boolean @default(false)`
- `configJson: Json`
- `createdAt`, `updatedAt`
- relation: `sessions: TestSession[]`

### 2.3 `TestSession`
- `id: String @id @default(uuid())`
- `blueprintId: String`
- `status: SessionStatus @default(STARTED)`
- `startedAt: DateTime @default(now())`
- `completedAt: DateTime?`
- `overallScore1to6: Float?`
- `overallScore0to120: Float?`
- relations:
  - `blueprint: ExamBlueprint`
  - `sections: SectionInstance[]`
  - `events: SessionEvent[]`
  - `report: AnalysisReport?`
  - `contextSnapshots: GenerationContextSnapshot[]`

### 2.4 `SectionInstance`
- `id: String @id @default(uuid())`
- `sessionId: String`
- `sectionType: SectionType`
- `orderIndex: Int`
- `timeLimitSeconds: Int`
- `startedAt: DateTime?`
- `completedAt: DateTime?`
- `score1to6: Float?`
- relations:
  - `session: TestSession`
  - `items: TestItem[]`
  - `contexts: GenerationContextSnapshot[]`

### 2.5 `TestItem`
- `id: String @id @default(uuid())`
- `sectionInstanceId: String`
- `taskType: String`
- `promptPayload: Json`
- `audioUrl: String?`
- `metadataJson: Json`
- `createdAt: DateTime @default(now())`
- relations:
  - `sectionInstance: SectionInstance`
  - `answers: Answer[]`

### 2.6 `Answer`
- `id: String @id @default(uuid())`
- `testItemId: String`
- `responsePayload: Json`
- `submittedAt: DateTime @default(now())`
- `scoreJson: Json?`
- relation: `testItem: TestItem`

### 2.7 `GenerationContextSnapshot`
- `id: String @id @default(uuid())`
- `sessionId: String`
- `sectionId: String`
- `targetItemOrder: Int`
- `contextJson: Json`
- `createdAt: DateTime @default(now())`
- relations:
  - `session: TestSession`
  - `section: SectionInstance`
- index:
  - `@@index([sectionId, targetItemOrder])`

### 2.8 `AnalysisReport`
- `id: String @id @default(uuid())`
- `sessionId: String @unique`
- `reportJson: Json`
- `pdfUrl: String?`
- `createdAt: DateTime @default(now())`
- relation: `session: TestSession`

### 2.9 `SessionEvent`
- `id: String @id @default(uuid())`
- `sessionId: String`
- `eventType: String`
- `payload: Json`
- `createdAt: DateTime @default(now())`
- relation: `session: TestSession`

## 3) Behavior notes tied to current code

1. `saveAnswer` currently does `deleteMany` by `testItemId` before insert, so effective behavior is latest-answer-per-item.
2. `SectionInstance.timeLimitSeconds` is stored for every section (including speaking), but frontend currently enforces per-question speaking timers from `promptPayload` values.
3. `GenerationContextSnapshot.contextJson` stores section context used for each generation call.

## 4) Data security notes

1. Plain API keys are not stored; only `apiKeyEncrypted` is persisted.
2. Decryption happens server-side in services when provider calls are executed.
3. UI receives masked API key via GraphQL model.

## 5) Known schema-level gaps

1. No user/account tables yet (single-user local assumption).
2. No dedicated table for speech transcripts/analysis artifacts (currently returned to UI and saved in answer text flow).
3. No queue-job state tables yet for background processing.
