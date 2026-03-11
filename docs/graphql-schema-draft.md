# GraphQL Schema (Current Implemented Shape)

Last updated: 2026-03-10
Source: generated from `backend/src/graphql/models.ts`, `inputs.ts`, and `session.resolver.ts`.

## 1) Scalars and enums

```graphql
scalar JSON

enum SessionStatus {
  STARTED
  IN_PROGRESS
  COMPLETED
  CANCELED
}

enum SectionType {
  READING
  LISTENING
  SPEAKING
  WRITING
}
```

## 2) Object types

```graphql
type ProviderConfigModel {
  id: ID!
  baseUrl: String!
  model: String!
  maskedApiKey: String!
  isActive: Boolean!
}

type TestItemModel {
  id: ID!
  taskType: String!
  promptPayload: JSON!
  audioUrl: String
}

type SectionInstanceModel {
  id: ID!
  sectionType: SectionType!
  orderIndex: Int!
  timeLimitSeconds: Int!
  score1to6: Float
}

type TestSessionModel {
  id: ID!
  status: SessionStatus!
  overallScore1to6: Float
  overallScore0to120: Float
  sections: [SectionInstanceModel!]
}

type AnalysisReportModel {
  id: ID!
  reportJson: JSON!
  pdfUrl: String
}
```

## 3) Inputs

```graphql
input SaveProviderConfigInput {
  baseUrl: String!
  apiKey: String!
  model: String!
}

input StartSessionInput {
  blueprintCode: String
}

input NextTaskInput {
  sessionId: ID!
  sectionInstanceId: ID!
}

input SaveAnswerInput {
  sessionId: ID!
  sectionInstanceId: ID!
  testItemId: ID!
  responsePayload: JSON!
}
```

## 4) Query operations

```graphql
type Query {
  activeProviderConfig: ProviderConfigModel
  session(id: String!): TestSessionModel
}
```

## 5) Mutation operations

```graphql
type Mutation {
  saveProviderConfig(input: SaveProviderConfigInput!): ProviderConfigModel!
  testProviderConnection(input: SaveProviderConfigInput!): Boolean!

  startSession(input: StartSessionInput): TestSessionModel!
  nextTask(input: NextTaskInput!): TestItemModel!
  saveAnswer(input: SaveAnswerInput!): Boolean!
  completeSession(sessionId: String!): TestSessionModel!
  generateReport(sessionId: String!): AnalysisReportModel!
}
```

## 6) Behavioral notes

1. `nextTask` is context-aware and persists `generation_context_snapshot` before generation.
2. `saveAnswer` returns `Boolean` in GraphQL even though backend persists an `Answer` row.
3. Speaking transcription/analysis is REST-only (`POST /speech/analyze`) and is not exposed through GraphQL.
4. Listening audio streaming is REST-only (`GET /audio/:fileName`).

## 7) Known schema gaps

1. No query for historical session list/report list yet.
2. No GraphQL type for speaking transcript analysis response.
3. No explicit mutation to finalize a single section independently.
