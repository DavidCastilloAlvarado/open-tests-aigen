import { ChangeEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { gql, useMutation, useQuery } from "@apollo/client";

type ActiveConfig = {
  id: string;
  baseUrl: string;
  model: string;
  maskedApiKey: string;
};

type SectionType = "READING" | "LISTENING" | "SPEAKING" | "WRITING";

type ViewMode = "home" | "test";

type SectionState = {
  id: string;
  orderIndex: number;
  sectionType: SectionType;
  timeLimitSeconds: number;
};

type SessionState = {
  id: string;
  status: string;
  sections?: SectionState[];
};

type AudioChunkPayload = {
  sequence?: number;
  audioUrl: string;
  voice?: string;
  gender?: string;
  instructions?: string;
  speakerRole?: string;
  transcriptChunk?: string;
};

type PromptPayload = {
  sectionType?: SectionType;
  instruction?: string;
  contextAware?: boolean;
  inputType?: "choice" | "text";
  passage?: string;
  transcript?: string;
  question?: string;
  options?: string[];
  speakingPrompt?: string;
  writingPrompt?: string;
  wordCount?: number;
  estimatedDurationSeconds?: number;
  topic?: string;
  questionType?: string;
  questionIndex?: number;
  questionSetSize?: number;
  stimulusType?: "passage" | "lecture" | "conversation" | "prompt";
  stimulusGroupId?: string;
  audioChunks?: AudioChunkPayload[];
  preparationTimeSeconds?: number;
  responseTimeSeconds?: number;
  speakingTimeLimitSeconds?: number;
};

type ItemState = {
  id: string;
  taskType: string;
  promptPayload: PromptPayload;
  audioUrl?: string | null;
};

type ResponseDraft = {
  choice?: string;
  text?: string;
  skipped?: boolean;
};

type SectionScorePayload = {
  sectionId?: string;
  sectionType: string;
  score: number;
};

type AnswerReviewPayload = {
  sectionType: string;
  questionIndex: number;
  question: string;
  userAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  explanation: string;
  topic?: string;
};

type FaultInsightPayload = {
  category: string;
  issue: string;
  evidence: string;
  improvement: string;
};

type ConstructedInsightPayload = {
  testItemId: string;
  sectionType: "SPEAKING" | "WRITING";
  prompt: string;
  userResponse: string;
  estimatedBand: number | null;
  strengths: string[];
  weaknesses: string[];
  faults: FaultInsightPayload[];
  b2Example: string;
  c1Example: string;
};

type FinalReportPayload = {
  summary?: string;
  overallScore: number | null;
  overallScore0to120Estimate: number | null;
  sectionScores: SectionScorePayload[];
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
  answerReview: AnswerReviewPayload[];
  speakingInsights: ConstructedInsightPayload[];
  writingInsights: ConstructedInsightPayload[];
  generatedAt?: string;
};

type RecentResultSectionScore = {
  sectionType: SectionType;
  score: number;
};

type RecentResult = {
  reportId: string;
  sessionId: string;
  createdAt: string;
  overallScore1to6: number | null;
  overallScore0to120: number | null;
  sectionScores: RecentResultSectionScore[];
};

type SpeakingAnalysisPayload = {
  transcript: string;
  analysis: string;
  transcriptionModel?: string;
  analysisModel?: string;
};

type SpeakingPhase = "preparation" | "ready_to_record" | "recording" | "processing" | "completed";

const SECTION_ORDER: SectionType[] = ["READING", "LISTENING", "SPEAKING", "WRITING"];

const ITEMS_PER_SECTION: Record<SectionType, number> = {
  READING: 48,
  LISTENING: 11,
  SPEAKING: 4,
  WRITING: 2,
};

const ACTIVE_CONFIG = gql`
  query ActiveProviderConfig {
    activeProviderConfig {
      id
      baseUrl
      model
      maskedApiKey
    }
  }
`;

const SAVE_CONFIG = gql`
  mutation SaveProviderConfig($input: SaveProviderConfigInput!) {
    saveProviderConfig(input: $input) {
      id
      baseUrl
      model
      maskedApiKey
    }
  }
`;

const START_SESSION = gql`
  mutation StartSession {
    startSession {
      id
      status
      sections {
        id
        orderIndex
        sectionType
        timeLimitSeconds
      }
    }
  }
`;

const NEXT_TASK = gql`
  mutation NextTask($input: NextTaskInput!) {
    nextTask(input: $input) {
      id
      taskType
      promptPayload
      audioUrl
    }
  }
`;

const SAVE_ANSWER = gql`
  mutation SaveAnswer($input: SaveAnswerInput!) {
    saveAnswer(input: $input)
  }
`;

const COMPLETE_SESSION = gql`
  mutation CompleteSession($sessionId: String!) {
    completeSession(sessionId: $sessionId) {
      id
      status
    }
  }
`;

const GENERATE_REPORT = gql`
  mutation GenerateReport($sessionId: String!) {
    generateReport(sessionId: $sessionId) {
      id
      reportJson
    }
  }
`;

const RECENT_RESULTS = gql`
  query RecentResults($limit: Int) {
    recentResults(limit: $limit) {
      reportId
      sessionId
      createdAt
      overallScore1to6
      overallScore0to120
      sectionScores {
        sectionType
        score
      }
    }
  }
`;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asDisplayText(value: unknown): string {
  const raw = asString(value);
  if (!raw) {
    return "";
  }

  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asAudioChunks(value: unknown): AudioChunkPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const chunks = value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const chunk = entry as Record<string, unknown>;
      const audioUrl = asString(chunk.audioUrl);
      if (!audioUrl) {
        return null;
      }

      return {
        sequence: asNumber(chunk.sequence) || undefined,
        audioUrl,
        voice: asString(chunk.voice) || undefined,
        gender: asString(chunk.gender) || undefined,
        instructions: asString(chunk.instructions) || undefined,
        speakerRole: asString(chunk.speakerRole) || undefined,
        transcriptChunk: asString(chunk.transcriptChunk) || undefined,
      } as AudioChunkPayload;
    })
    .filter((entry): entry is AudioChunkPayload => Boolean(entry));

  return chunks.sort((a, b) => (a.sequence || Number.MAX_SAFE_INTEGER) - (b.sequence || Number.MAX_SAFE_INTEGER));
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asFinalReportPayload(value: unknown): FinalReportPayload | null {
  const report = asObject(value);
  if (!report) {
    return null;
  }

  const sectionScoresRaw = Array.isArray(report.sectionScores) ? report.sectionScores : [];
  const sectionScores = sectionScoresRaw
    .map((entry): SectionScorePayload | null => {
      const scoreEntry = asObject(entry);
      if (!scoreEntry) {
        return null;
      }

      const sectionType = asString(scoreEntry.sectionType);
      const score = asNumber(scoreEntry.score);
      if (!sectionType || score === null) {
        return null;
      }

      return {
        sectionId: asString(scoreEntry.sectionId) || undefined,
        sectionType,
        score,
      };
    })
    .filter((entry): entry is SectionScorePayload => entry !== null);

  const answerReviewRaw = Array.isArray(report.answerReview) ? report.answerReview : [];
  const answerReview = answerReviewRaw
    .map((entry): AnswerReviewPayload | null => {
      const reviewEntry = asObject(entry);
      if (!reviewEntry) {
        return null;
      }

      const sectionType = asString(reviewEntry.sectionType);
      const questionIndex = asNumber(reviewEntry.questionIndex);
      const question = asString(reviewEntry.question);
      if (!sectionType || questionIndex === null || !question) {
        return null;
      }

      return {
        sectionType,
        questionIndex,
        question,
        userAnswer: asString(reviewEntry.userAnswer),
        correctAnswer: asString(reviewEntry.correctAnswer),
        isCorrect: asBoolean(reviewEntry.isCorrect),
        explanation: asString(reviewEntry.explanation),
        topic: asString(reviewEntry.topic) || undefined,
      };
    })
    .filter((entry): entry is AnswerReviewPayload => entry !== null);

  function parseConstructedInsights(value: unknown): ConstructedInsightPayload[] {
    const insightsRaw = Array.isArray(value) ? value : [];
    return insightsRaw
      .map((entry) => {
        const insightEntry = asObject(entry);
        if (!insightEntry) {
          return null;
        }

        const sectionTypeRaw = asString(insightEntry.sectionType).toUpperCase();
        const sectionType = sectionTypeRaw === "SPEAKING" || sectionTypeRaw === "WRITING" ? sectionTypeRaw : "";
        const testItemId = asString(insightEntry.testItemId);
        if (!sectionType || !testItemId) {
          return null;
        }

        const faultsRaw = Array.isArray(insightEntry.faults) ? insightEntry.faults : [];
        const faults: FaultInsightPayload[] = faultsRaw
          .map((faultEntry) => {
            const fault = asObject(faultEntry);
            if (!fault) {
              return null;
            }
            return {
              category: asString(fault.category) || "General",
              issue: asString(fault.issue),
              evidence: asString(fault.evidence),
              improvement: asString(fault.improvement),
            };
          })
          .filter((fault): fault is FaultInsightPayload => Boolean(fault));

        return {
          testItemId,
          sectionType,
          prompt: asString(insightEntry.prompt),
          userResponse: asString(insightEntry.userResponse),
          estimatedBand: asNumber(insightEntry.estimatedBand),
          strengths: asStringArray(insightEntry.strengths),
          weaknesses: asStringArray(insightEntry.weaknesses),
          faults,
          b2Example: asString(insightEntry.b2Example),
          c1Example: asString(insightEntry.c1Example),
        } as ConstructedInsightPayload;
      })
      .filter((entry): entry is ConstructedInsightPayload => Boolean(entry));
  }

  const speakingInsights = parseConstructedInsights(report.speakingInsights);
  const writingInsights = parseConstructedInsights(report.writingInsights);

  return {
    summary: asString(report.summary) || undefined,
    overallScore: asNumber(report.overallScore),
    overallScore0to120Estimate: asNumber(report.overallScore0to120Estimate),
    sectionScores,
    strengths: asStringArray(report.strengths),
    weaknesses: asStringArray(report.weaknesses),
    improvements: asStringArray(report.improvements),
    answerReview,
    speakingInsights,
    writingInsights,
    generatedAt: asString(report.generatedAt) || undefined,
  };
}

function countWords(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "00:00";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function backendApiBaseUrl(): string {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const explicit = meta.env?.VITE_API_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const graphqlUrl = (meta.env?.VITE_GRAPHQL_URL || "http://localhost:4000/graphql").trim();
  return graphqlUrl.replace(/\/graphql\/?$/, "").replace(/\/+$/, "");
}

function providerDisplayName(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "Configured provider";
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "Local provider";
    }
    if (hostname.includes("azure")) {
      return "Azure OpenAI";
    }
    if (hostname.includes("openai")) {
      return "OpenAI-compatible";
    }

    const label = hostname.split(".")[0] || hostname;
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return "Configured provider";
  }
}

function sectionDisplayName(sectionType: string): string {
  const normalized = sectionType.trim().toUpperCase();
  if (normalized === "READING") {
    return "Reading";
  }
  if (normalized === "LISTENING") {
    return "Listening";
  }
  if (normalized === "SPEAKING") {
    return "Speaking";
  }
  if (normalized === "WRITING") {
    return "Writing";
  }
  return sectionType;
}

function formatHistoryTimestamp(value: string): string {
  if (!value) {
    return "Unknown time";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function findRecentSectionScore(result: RecentResult, sectionType: SectionType): number | null {
  const match = result.sectionScores.find((entry: RecentResultSectionScore) => entry.sectionType === sectionType);
  return typeof match?.score === "number" ? match.score : null;
}

const PDF_ENCODER = new TextEncoder();

function pdfByteLength(value: string): number {
  return PDF_ENCODER.encode(value).length;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimplePdf(lines: string[]): Uint8Array {
  const maxLinesPerPage = 45;
  const pages: string[] = [];

  for (let offset = 0; offset < lines.length; offset += maxLinesPerPage) {
    const pageLines = lines.slice(offset, offset + maxLinesPerPage);
    let stream = "BT\n/F1 10 Tf\n50 770 Td\n";
    pageLines.forEach((line, index) => {
      const safe = escapePdfText(line || " ");
      if (index === 0) {
        stream += `(${safe}) Tj\n`;
      } else {
        stream += `0 -16 Td (${safe}) Tj\n`;
      }
    });
    stream += "ET\n";
    pages.push(stream);
  }

  if (pages.length === 0) {
    pages.push("BT\n/F1 10 Tf\n50 770 Td\n(Report unavailable) Tj\nET\n");
  }

  const totalObjects = 3 + pages.length * 2;
  const objects = new Array<string>(totalObjects + 1);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((stream, index) => {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = 5 + index * 2;
    objects[contentObjectNumber] = `<< /Length ${pdfByteLength(stream)} >>\nstream\n${stream}endstream`;
    objects[pageObjectNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets = new Array<number>(totalObjects + 1).fill(0);

  for (let objectId = 1; objectId <= totalObjects; objectId += 1) {
    offsets[objectId] = pdfByteLength(pdf);
    pdf += `${objectId} 0 obj\n${objects[objectId] || ""}\nendobj\n`;
  }

  const xrefOffset = pdfByteLength(pdf);
  pdf += `xref\n0 ${totalObjects + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let objectId = 1; objectId <= totalObjects; objectId += 1) {
    pdf += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return PDF_ENCODER.encode(pdf);
}

function reportToPdfLines(report: FinalReportPayload, sessionId?: string): string[] {
  const lines: string[] = [];
  lines.push("Open Tests AIGen - Final Evaluation Report");
  lines.push(`Session: ${sessionId || "-"}`);
  lines.push(`Generated: ${report.generatedAt || new Date().toISOString()}`);
  lines.push("");
  lines.push(`Overall (1-6): ${report.overallScore ?? "-"}`);
  lines.push(`Estimated TOEFL (0-120): ${report.overallScore0to120Estimate ?? "-"}`);
  lines.push("");

  if (report.summary) {
    lines.push("Summary:");
    lines.push(report.summary);
    lines.push("");
  }

  lines.push("Section Scores:");
  report.sectionScores.forEach((entry) => {
    lines.push(`- ${entry.sectionType}: ${entry.score}`);
  });
  lines.push("");

  if (report.strengths.length > 0) {
    lines.push("Strengths:");
    report.strengths.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
  }

  if (report.weaknesses.length > 0) {
    lines.push("Weaknesses:");
    report.weaknesses.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
  }

  if (report.improvements.length > 0) {
    lines.push("Improvements:");
    report.improvements.forEach((entry) => lines.push(`- ${entry}`));
    lines.push("");
  }

  if (report.answerReview.length > 0) {
    lines.push("Reading & Listening Answer Review:");
    report.answerReview.forEach((entry) => {
      lines.push(`${entry.sectionType} Q${entry.questionIndex} - ${entry.isCorrect ? "Correct" : "Incorrect"}`);
      lines.push(`Question: ${entry.question}`);
      lines.push(`Your answer: ${entry.userAnswer || "(No answer)"}`);
      lines.push(`Correct answer: ${entry.correctAnswer || "(Unavailable)"}`);
      lines.push(`Why: ${entry.explanation || "No explanation provided."}`);
      lines.push("");
    });
  }

  const appendConstructedInsights = (sectionTitle: string, insights: ConstructedInsightPayload[]) => {
    if (insights.length === 0) {
      return;
    }

    lines.push(sectionTitle);
    insights.forEach((insight) => {
      lines.push(`${insight.sectionType} task ${insight.testItemId}`);
      lines.push(`Estimated band: ${insight.estimatedBand ?? "-"}`);
      lines.push(`Prompt: ${insight.prompt || "-"}`);
      lines.push(`Your response: ${insight.userResponse || "(No response)"}`);
      if (insight.strengths.length > 0) {
        lines.push(`Strengths: ${insight.strengths.join(" | ")}`);
      }
      if (insight.weaknesses.length > 0) {
        lines.push(`Weaknesses: ${insight.weaknesses.join(" | ")}`);
      }
      insight.faults.forEach((fault, faultIndex) => {
        lines.push(`Fault ${faultIndex + 1} [${fault.category}]`);
        lines.push(`Issue: ${fault.issue}`);
        lines.push(`Evidence: ${fault.evidence}`);
        lines.push(`Improve: ${fault.improvement}`);
      });
      lines.push(`B2 example: ${insight.b2Example || "-"}`);
      lines.push(`C1 example: ${insight.c1Example || "-"}`);
      lines.push("");
    });
  };

  appendConstructedInsights("Speaking Insights:", report.speakingInsights);
  appendConstructedInsights("Writing Insights:", report.writingInsights);

  return lines;
}

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("home");

  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4.1-mini");
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isSectionMenuOpen, setIsSectionMenuOpen] = useState(false);

  const [session, setSession] = useState<SessionState | null>(null);
  const [sections, setSections] = useState<SectionState[]>([]);
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [sectionItemsById, setSectionItemsById] = useState<Record<string, ItemState[]>>({});
  const [sectionCursorById, setSectionCursorById] = useState<Record<string, number>>({});
  const [responsesByItemId, setResponsesByItemId] = useState<Record<string, ResponseDraft>>({});

  const [selectedChoice, setSelectedChoice] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [runnerError, setRunnerError] = useState("");
  const [sessionComplete, setSessionComplete] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [activeAudioChunkIndex, setActiveAudioChunkIndex] = useState(-1);
  const [showListeningTranscript, setShowListeningTranscript] = useState(false);
  const [sectionSecondsRemaining, setSectionSecondsRemaining] = useState<number | null>(null);
  const [speakingQuestionSecondsRemaining, setSpeakingQuestionSecondsRemaining] = useState<number | null>(null);
  const [speakingPhase, setSpeakingPhase] = useState<SpeakingPhase | null>(null);
  const [finalReport, setFinalReport] = useState<FinalReportPayload | null>(null);
  const [speakingTranscript, setSpeakingTranscript] = useState("");
  const [speakingAnalysis, setSpeakingAnalysis] = useState("");
  const [speakingAnalysisModel, setSpeakingAnalysisModel] = useState("");
  const [recordedAudioBlob, setRecordedAudioBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmittingSpeakingAudio, setIsSubmittingSpeakingAudio] = useState(false);
  const [isGeneratingContent, setIsGeneratingContent] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const sequenceAudioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayedStimulusRef = useRef<string | null>(null);
  const timeoutHandledSectionRef = useRef<string | null>(null);
  const speakingTimeoutHandledItemRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const pendingRecordingBlobResolverRef = useRef<((blob: Blob | null, errorMessage?: string) => void) | null>(null);
  const autoProcessOnStopRef = useRef(false);

  const speechSynthesisSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const apiBaseUrl = useMemo(() => backendApiBaseUrl(), []);

  const { data, refetch } = useQuery<{ activeProviderConfig: ActiveConfig | null }>(ACTIVE_CONFIG);
  const { data: recentResultsData, refetch: refetchRecentResults } = useQuery<{ recentResults: RecentResult[] }, { limit: number }>(
    RECENT_RESULTS,
    { variables: { limit: 20 } },
  );
  const [saveConfig, { loading: savingConfig }] = useMutation(SAVE_CONFIG);
  const [startSession, { loading: creatingSession }] = useMutation(START_SESSION);
  const [nextTask] = useMutation(NEXT_TASK);
  const [saveAnswerMutation, { loading: savingAnswer }] = useMutation(SAVE_ANSWER);
  const [completeSession] = useMutation(COMPLETE_SESSION);
  const [generateReportMutation] = useMutation(GENERATE_REPORT);

  const activeProviderConfig = data?.activeProviderConfig || null;
  const hasConfig = useMemo(() => Boolean(data?.activeProviderConfig), [data]);
  const activeSection = sections[currentSectionIndex] || null;
  const activeSectionItems = activeSection ? sectionItemsById[activeSection.id] || [] : [];
  const activeQuestionIndex = activeSection ? sectionCursorById[activeSection.id] || 0 : 0;
  const item = activeSectionItems[activeQuestionIndex] || null;

  const sectionTypeForLimit = (activeSection?.sectionType || item?.promptPayload?.sectionType) as SectionType | undefined;
  const dynamicSectionLimit = asNumber(item?.promptPayload?.questionSetSize);
  const sectionLimit =
    (dynamicSectionLimit && dynamicSectionLimit > 0
      ? dynamicSectionLimit
      : sectionTypeForLimit
        ? ITEMS_PER_SECTION[sectionTypeForLimit] || 1
        : 1) || 1;

  const sectionLabel = activeSection?.sectionType || item?.promptPayload?.sectionType || "-";
  const options = asStringArray(item?.promptPayload?.options);
  const questionType = asString(item?.promptPayload?.questionType) || "single_response";
  const stimulusType = asString(item?.promptPayload?.stimulusType) || "prompt";
  const isWritingTextResponse = sectionLabel === "WRITING" && item?.promptPayload?.inputType !== "choice";
  const writingResponseWordCount = isWritingTextResponse ? countWords(answerText) : 0;

  const passageWordCount = asNumber(item?.promptPayload?.wordCount) || countWords(asString(item?.promptPayload?.passage));
  const transcriptWordCount = asNumber(item?.promptPayload?.wordCount) || countWords(asString(item?.promptPayload?.transcript));
  const estimatedDurationSeconds =
    asNumber(item?.promptPayload?.estimatedDurationSeconds) ||
    (transcriptWordCount > 0 ? Math.round((transcriptWordCount / 145) * 60) : 0);
  const questionOrdinal = asNumber(item?.promptPayload?.questionIndex) || Math.min(activeQuestionIndex + 1, sectionLimit);
  const speakingPreparationSeconds = Math.max(0, asNumber(item?.promptPayload?.preparationTimeSeconds) || 15);
  const speakingResponseSeconds = Math.max(15, asNumber(item?.promptPayload?.responseTimeSeconds) || 45);
  const speakingTimeLimitSeconds = Math.max(
    15,
    asNumber(item?.promptPayload?.speakingTimeLimitSeconds) || speakingPreparationSeconds + speakingResponseSeconds,
  );
  const listeningAudioChunks = asAudioChunks(item?.promptPayload?.audioChunks);
  const listeningPlaybackQueue: AudioChunkPayload[] =
    listeningAudioChunks.length > 0
      ? listeningAudioChunks
      : item?.audioUrl
        ? [{ sequence: 1, audioUrl: item.audioUrl }]
        : [];
  const activeChunk = activeAudioChunkIndex >= 0 ? listeningPlaybackQueue[activeAudioChunkIndex] || null : null;

  const isFirstQuestion = activeQuestionIndex <= 0;
  const isLastLoadedQuestion = activeQuestionIndex >= activeSectionItems.length - 1;
  const hasMoreQuestionsInSection = activeSectionItems.length < sectionLimit;
  const canGoToAnotherQuestion = !isLastLoadedQuestion || hasMoreQuestionsInSection;
  const nextActionLabel = canGoToAnotherQuestion
    ? "Next Question"
    : currentSectionIndex < sections.length - 1
      ? "Next Section"
      : "Finish Test";
  const recentResults = useMemo(() => recentResultsData?.recentResults || [], [recentResultsData]);
  const historicalResults = useMemo(() => recentResults.slice().reverse(), [recentResults]);
  const activeProviderSummary = hasConfig
    ? `${providerDisplayName(activeProviderConfig?.baseUrl || "")} (${activeProviderConfig?.model || "-"})`
    : "No provider configured yet.";

  const activeClockSeconds = activeSection?.sectionType === "SPEAKING" ? speakingQuestionSecondsRemaining : sectionSecondsRemaining;
  const clockValue = activeClockSeconds === null ? "--:--" : formatDuration(activeClockSeconds);
  const showClock = viewMode === "test" && !sessionComplete && !!activeSection;
  const modelBusy = isGeneratingContent || isSubmittingSpeakingAudio || speakingPhase === "processing";
  const isBusy = savingAnswer || modelBusy || isRecording;
  const loadingCopy = isSubmittingSpeakingAudio
    ? "Analyzing your speaking response..."
    : "Generating the next task...";
  const speakingPhaseLabel =
    speakingPhase === "preparation"
      ? "Preparation"
      : speakingPhase === "ready_to_record"
        ? "Ready to record"
        : speakingPhase === "recording"
          ? "Recording"
          : speakingPhase === "processing"
            ? "Processing"
            : speakingPhase === "completed"
              ? "Completed"
              : "-";
  const speakingTimerLabel =
    speakingPhase === "preparation"
      ? "Preparation time remaining"
      : speakingPhase === "recording"
        ? "Speaking time remaining"
        : "Response time available";

  const readingListeningAccuracy = useMemo(() => {
    if (!finalReport || finalReport.answerReview.length === 0) {
      return null;
    }

    const correct = finalReport.answerReview.filter((entry: AnswerReviewPayload) => entry.isCorrect).length;
    const total = finalReport.answerReview.length;
    return {
      correct,
      total,
      percentage: Math.round((correct / Math.max(total, 1)) * 100),
    };
  }, [finalReport]);

  useEffect(() => {
    if (viewMode !== "test" || sessionComplete) {
      setIsSectionMenuOpen(false);
    }
  }, [viewMode, sessionComplete, currentSectionIndex]);

  useEffect(() => {
    return () => {
      if (sequenceAudioRef.current) {
        sequenceAudioRef.current.pause();
        sequenceAudioRef.current.src = "";
        sequenceAudioRef.current.onended = null;
        sequenceAudioRef.current.onerror = null;
        sequenceAudioRef.current = null;
      }
      if (speechSynthesisSupported && typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (recordingStreamRef.current) {
        for (const track of recordingStreamRef.current.getTracks()) {
          track.stop();
        }
        recordingStreamRef.current = null;
      }
    };
  }, [speechSynthesisSupported]);

  useEffect(() => {
    if (!item) {
      setSelectedChoice("");
      setAnswerText("");
      return;
    }

    const draft = responsesByItemId[item.id];
    setSelectedChoice(asString(draft?.choice));
    setAnswerText(asString(draft?.text));
  }, [item?.id]);

  useEffect(() => {
    if (pendingRecordingBlobResolverRef.current) {
      pendingRecordingBlobResolverRef.current(null, "Recording was interrupted because the active task changed.");
      pendingRecordingBlobResolverRef.current = null;
    }
    autoProcessOnStopRef.current = false;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (recordingStreamRef.current) {
      for (const track of recordingStreamRef.current.getTracks()) {
        track.stop();
      }
      recordingStreamRef.current = null;
    }
    recordingChunksRef.current = [];
    setIsRecording(false);
    setRecordedAudioBlob(null);
    setSpeakingTranscript("");
    setSpeakingAnalysis("");
    setSpeakingAnalysisModel("");
    setIsSubmittingSpeakingAudio(false);
    setSpeakingPhase(activeSection?.sectionType === "SPEAKING" ? "preparation" : null);
  }, [item?.id, activeSection?.sectionType]);

  useEffect(() => {
    setShowListeningTranscript(false);
  }, [item?.id, activeSection?.sectionType]);

  useEffect(() => {
    if (activeSection?.sectionType !== "LISTENING") {
      stopTranscriptAudio();
      autoPlayedStimulusRef.current = null;
    }
  }, [activeSection?.sectionType]);

  useEffect(() => {
    if (!item || activeSection?.sectionType !== "LISTENING") {
      return;
    }

    const currentStimulusGroup = asString(item.promptPayload?.stimulusGroupId) || item.id;
    if (autoPlayedStimulusRef.current === currentStimulusGroup) {
      return;
    }

    autoPlayedStimulusRef.current = currentStimulusGroup;
    const chunkQueue = asAudioChunks(item.promptPayload?.audioChunks);
    if (chunkQueue.length > 0) {
      playAudioChunks(chunkQueue);
      return;
    }

    if (item.audioUrl) {
      playAudioChunks([{ sequence: 1, audioUrl: item.audioUrl }]);
      return;
    }

    const transcript = asString(item.promptPayload?.transcript).trim();
    if (transcript && speechSynthesisSupported) {
      playTranscriptAudio(transcript);
    }
  }, [activeSection?.sectionType, item?.id, item?.audioUrl, speechSynthesisSupported]);

  useEffect(() => {
    if (viewMode !== "test" || !activeSection || sessionComplete) {
      setSectionSecondsRemaining(null);
      setSpeakingQuestionSecondsRemaining(null);
      return;
    }

    if (activeSection.sectionType === "SPEAKING") {
      setSectionSecondsRemaining(null);
      return;
    }

    timeoutHandledSectionRef.current = null;
    setSectionSecondsRemaining(activeSection.timeLimitSeconds);
  }, [viewMode, activeSection?.id, activeSection?.sectionType, sessionComplete]);

  useEffect(() => {
    if (viewMode !== "test" || !activeSection || sessionComplete || activeSection.sectionType !== "SPEAKING" || !item) {
      setSpeakingQuestionSecondsRemaining(null);
      setSpeakingPhase(null);
      return;
    }

    speakingTimeoutHandledItemRef.current = null;
    setSpeakingPhase("preparation");
    setSpeakingQuestionSecondsRemaining(speakingPreparationSeconds);
  }, [
    viewMode,
    activeSection?.id,
    activeSection?.sectionType,
    item?.id,
    sessionComplete,
    speakingPreparationSeconds,
  ]);

  useEffect(() => {
    if (viewMode !== "test" || !activeSection || sessionComplete) {
      return;
    }

    if (activeSection.sectionType === "SPEAKING") {
      return;
    }

    if (modelBusy) {
      return;
    }

    const timer = window.setInterval(() => {
      setSectionSecondsRemaining((previous: number | null) => {
        if (previous === null) {
          return previous;
        }
        return previous > 0 ? previous - 1 : 0;
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [viewMode, activeSection?.id, activeSection?.sectionType, sessionComplete, modelBusy]);

  useEffect(() => {
    if (viewMode !== "test" || !activeSection || sessionComplete || activeSection.sectionType !== "SPEAKING" || !item) {
      return;
    }

    if (modelBusy) {
      return;
    }

    if (speakingPhase !== "preparation" && speakingPhase !== "recording") {
      return;
    }

    const timer = window.setInterval(() => {
      setSpeakingQuestionSecondsRemaining((previous: number | null) => {
        if (previous === null) {
          return previous;
        }
        return previous > 0 ? previous - 1 : 0;
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [viewMode, activeSection?.id, activeSection?.sectionType, item?.id, sessionComplete, modelBusy, speakingPhase]);

  useEffect(() => {
    if (!modelBusy) {
      setGenerationProgress(0);
      return;
    }

    setGenerationProgress((previous: number) => (previous > 0 ? previous : 6));
    const timer = window.setInterval(() => {
      setGenerationProgress((previous: number) =>
        Math.min(92, previous + Math.max(2, Math.round((100 - previous) / 18))),
      );
    }, 260);

    return () => {
      window.clearInterval(timer);
    };
  }, [modelBusy]);

  useEffect(() => {
    if (
      viewMode !== "test" ||
      !activeSection ||
      activeSection.sectionType === "SPEAKING" ||
      sessionComplete ||
      sectionSecondsRemaining !== 0
    ) {
      return;
    }
    if (timeoutHandledSectionRef.current === activeSection.id) {
      return;
    }
    timeoutHandledSectionRef.current = activeSection.id;
    void onSectionTimeExpired();
  }, [sectionSecondsRemaining, viewMode, activeSection?.id, sessionComplete]);

  useEffect(() => {
    if (
      viewMode !== "test" ||
      !activeSection ||
      activeSection.sectionType !== "SPEAKING" ||
      !item ||
      sessionComplete ||
      speakingQuestionSecondsRemaining !== 0
    ) {
      return;
    }

    if (speakingPhase === "preparation") {
      setSpeakingPhase("ready_to_record");
      setSpeakingQuestionSecondsRemaining(speakingResponseSeconds);
      return;
    }

    if (speakingPhase !== "recording") {
      return;
    }

    if (speakingTimeoutHandledItemRef.current === item.id) {
      return;
    }

    speakingTimeoutHandledItemRef.current = item.id;
    void onSpeakingQuestionTimeExpired();
  }, [
    speakingQuestionSecondsRemaining,
    viewMode,
    activeSection?.id,
    activeSection?.sectionType,
    item?.id,
    sessionComplete,
    speakingPhase,
    speakingResponseSeconds,
  ]);

  function stopTranscriptAudio(): void {
    if (sequenceAudioRef.current) {
      sequenceAudioRef.current.pause();
      sequenceAudioRef.current.src = "";
      sequenceAudioRef.current.onended = null;
      sequenceAudioRef.current.onerror = null;
      sequenceAudioRef.current = null;
    }

    if (speechSynthesisSupported && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      utteranceRef.current = null;
    }

    setIsSpeaking(false);
    setActiveAudioChunkIndex(-1);
  }

  function playAudioChunks(chunks: AudioChunkPayload[]): void {
    if (chunks.length === 0) {
      setRunnerError("No generated audio chunks are available for this stimulus.");
      return;
    }

    setRunnerError("");
    stopTranscriptAudio();

    const player = new Audio();
    sequenceAudioRef.current = player;

    let cursor = 0;
    const playCurrentChunk = () => {
      if (sequenceAudioRef.current !== player) {
        return;
      }

      const chunk = chunks[cursor];
      if (!chunk) {
        sequenceAudioRef.current = null;
        setIsSpeaking(false);
        setActiveAudioChunkIndex(-1);
        return;
      }

      setActiveAudioChunkIndex(cursor);
      player.src = chunk.audioUrl;
      player.onended = () => {
        cursor += 1;
        playCurrentChunk();
      };
      player.onerror = () => {
        if (sequenceAudioRef.current === player) {
          sequenceAudioRef.current = null;
        }
        setIsSpeaking(false);
        setActiveAudioChunkIndex(-1);
        setRunnerError("Chunked listening playback failed.");
      };
      void player.play().catch(() => {
        if (sequenceAudioRef.current === player) {
          sequenceAudioRef.current = null;
        }
        setIsSpeaking(false);
        setActiveAudioChunkIndex(-1);
        setRunnerError("Audio playback was blocked by the browser. Click Play Audio again.");
      });
    };

    setIsSpeaking(true);
    playCurrentChunk();
  }

  function playListeningStimulusAudio(): void {
    if (listeningPlaybackQueue.length > 0) {
      playAudioChunks(listeningPlaybackQueue);
      return;
    }
    playTranscriptAudio();
  }

  function playTranscriptAudio(explicitTranscript?: string): void {
    const transcript = (explicitTranscript || asString(item?.promptPayload?.transcript)).trim();
    if (!transcript) {
      setRunnerError("No transcript available to play.");
      return;
    }
    if (!speechSynthesisSupported) {
      setRunnerError("Browser speech playback is unavailable. Provide provider audioUrl or use a browser with speech synthesis.");
      return;
    }

    setRunnerError("");
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(transcript);
    utterance.lang = "en-US";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.onend = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
      }
      setIsSpeaking(false);
    };
    utterance.onerror = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
      }
      setIsSpeaking(false);
      setRunnerError("Listening audio playback failed in this browser.");
    };

    utteranceRef.current = utterance;
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  function resetCurrentTestState(): void {
    stopTranscriptAudio();
    if (pendingRecordingBlobResolverRef.current) {
      pendingRecordingBlobResolverRef.current(null, "Recording reset before completion.");
      pendingRecordingBlobResolverRef.current = null;
    }
    autoProcessOnStopRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (recordingStreamRef.current) {
      for (const track of recordingStreamRef.current.getTracks()) {
        track.stop();
      }
      recordingStreamRef.current = null;
    }

    setViewMode("home");
    setSession(null);
    setSections([]);
    setCurrentSectionIndex(0);
    setIsSectionMenuOpen(false);
    setSectionItemsById({});
    setSectionCursorById({});
    setResponsesByItemId({});
    setSelectedChoice("");
    setAnswerText("");
    setSessionComplete(false);
    setRunnerError("");
    setShowListeningTranscript(false);
    setSectionSecondsRemaining(null);
    setSpeakingQuestionSecondsRemaining(null);
    setSpeakingPhase(null);
    setFinalReport(null);
    setRecordedAudioBlob(null);
    setSpeakingTranscript("");
    setSpeakingAnalysis("");
    setSpeakingAnalysisModel("");
    setIsRecording(false);
    setIsSubmittingSpeakingAudio(false);
    setIsGeneratingContent(false);
    setGenerationProgress(0);
    autoPlayedStimulusRef.current = null;
    timeoutHandledSectionRef.current = null;
    speakingTimeoutHandledItemRef.current = null;
  }

  function onHomeClick(): void {
    if (viewMode === "test" && session && !sessionComplete) {
      const confirmed = window.confirm(
        "Go back to Home? Your current test flow will be reset in this browser session.",
      );
      if (!confirmed) {
        return;
      }
    }
    resetCurrentTestState();
  }

  async function onSaveConfig(): Promise<void> {
    setRunnerError("");
    try {
      await saveConfig({ variables: { input: { baseUrl, apiKey, model } } });
      await refetch();
      setIsConfigModalOpen(false);
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not save provider configuration.");
    }
  }

  async function startRecordingSpeakingAudio(): Promise<void> {
    if (activeSection?.sectionType !== "SPEAKING") {
      setRunnerError("Recording is only available during speaking tasks.");
      return;
    }

    if (speakingPhase === "preparation") {
      setRunnerError("Preparation time is still running. Start recording when prep time ends.");
      return;
    }

    if (speakingPhase === "processing") {
      setRunnerError("Speaking response is still processing. Please wait.");
      return;
    }

    if (speakingQuestionSecondsRemaining !== null && speakingQuestionSecondsRemaining <= 0) {
      setRunnerError("Speaking time has already expired for this task.");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRunnerError("This browser does not support microphone recording.");
      return;
    }

    setRunnerError("");
    setRecordedAudioBlob(null);
    setSpeakingTranscript("");
    setSpeakingAnalysis("");
    setSpeakingAnalysisModel("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;

      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      const recorder = preferredMimeType ? new MediaRecorder(stream, { mimeType: preferredMimeType }) : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const recorded = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const finalizedBlob = recorded.size > 0 ? recorded : null;
        setRecordedAudioBlob(finalizedBlob);
        recordingChunksRef.current = [];
        setIsRecording(false);
        if (recordingStreamRef.current) {
          for (const track of recordingStreamRef.current.getTracks()) {
            track.stop();
          }
          recordingStreamRef.current = null;
        }

        if (!autoProcessOnStopRef.current && activeSection?.sectionType === "SPEAKING") {
          setSpeakingPhase("ready_to_record");
        }

        if (!finalizedBlob) {
          setRunnerError("Recording stopped but no audio file was produced. Please record again.");
        }

        if (pendingRecordingBlobResolverRef.current) {
          pendingRecordingBlobResolverRef.current(finalizedBlob, finalizedBlob ? undefined : "No audio file was produced.");
          pendingRecordingBlobResolverRef.current = null;
        }

        autoProcessOnStopRef.current = false;
      };

      recorder.onerror = () => {
        setIsRecording(false);
        const errorMessage = "Audio recording failed. Browser media recorder reported an error.";
        setRunnerError(errorMessage);
        if (pendingRecordingBlobResolverRef.current) {
          pendingRecordingBlobResolverRef.current(null, errorMessage);
          pendingRecordingBlobResolverRef.current = null;
        }
        autoProcessOnStopRef.current = false;
        if (activeSection?.sectionType === "SPEAKING") {
          setSpeakingPhase("ready_to_record");
        }
      };

      recorder.start(250);
      setIsRecording(true);
      setSpeakingPhase("recording");
      setSpeakingQuestionSecondsRemaining((previous: number | null) => (previous === null ? speakingResponseSeconds : previous));
      speakingTimeoutHandledItemRef.current = null;
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not access your microphone.");
      setIsRecording(false);
      setSpeakingPhase("ready_to_record");
    }
  }

  function stopRecordingSpeakingAudio(): void {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setIsRecording(false);
      if (!recordedAudioBlob) {
        setRunnerError("Recording is not active and no audio file is available.");
      }
      return;
    }

    try {
      recorder.stop();
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not stop audio recording.");
    }
  }

  async function stopRecordingAndCaptureBlob(): Promise<Blob> {
    if (pendingRecordingBlobResolverRef.current) {
      throw new Error("A recording finalization process is already running.");
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      if (recordedAudioBlob && recordedAudioBlob.size > 0) {
        return recordedAudioBlob;
      }
      throw new Error("Recording is not active and no captured audio file is available.");
    }

    autoProcessOnStopRef.current = true;

    return await new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRecordingBlobResolverRef.current = null;
        autoProcessOnStopRef.current = false;
        reject(new Error("Recording stop timed out before an audio file was produced."));
      }, 7000);

      pendingRecordingBlobResolverRef.current = (blob: Blob | null, errorMessage?: string) => {
        window.clearTimeout(timeout);
        pendingRecordingBlobResolverRef.current = null;
        if (!blob || blob.size === 0) {
          reject(new Error(errorMessage || "Recording finished without a valid audio file."));
          return;
        }
        resolve(blob);
      };

      try {
        recorder.stop();
      } catch (error) {
        window.clearTimeout(timeout);
        pendingRecordingBlobResolverRef.current = null;
        autoProcessOnStopRef.current = false;
        reject(error instanceof Error ? error : new Error("Could not stop the recorder."));
      }
    });
  }

  async function submitSpeakingAudioForAnalysis(audioBlobOverride?: Blob): Promise<string> {
    const sourceBlob = audioBlobOverride || recordedAudioBlob;
    if (!sourceBlob || sourceBlob.size === 0 || !session || !activeSection || !item) {
      const message = "Record your speaking response before analysis. Audio file is missing or empty.";
      setRunnerError(message);
      throw new Error(message);
    }

    setRunnerError("");
    setIsSubmittingSpeakingAudio(true);
    setSpeakingPhase("processing");

    try {
      const formData = new FormData();
      formData.append("file", sourceBlob, "speaking-response.webm");
      formData.append("sessionId", session.id);
      formData.append("sectionInstanceId", activeSection.id);
      formData.append("testItemId", item.id);
      formData.append("speakingPrompt", asString(item.promptPayload?.speakingPrompt));

      const response = await fetch(`${apiBaseUrl}/speech/analyze`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const details = await response.text();
        throw new Error(details || "Speaking analysis request failed.");
      }

      const payload = (await response.json()) as SpeakingAnalysisPayload;
      const transcript = asString(payload.transcript);
      if (!transcript.trim()) {
        throw new Error("Speech analysis returned an empty transcript. Answer cannot be scored.");
      }
      setSpeakingTranscript(transcript);
      setSpeakingAnalysis(asString(payload.analysis));
      setSpeakingAnalysisModel(asString(payload.analysisModel) || asString(payload.transcriptionModel));
      setAnswerText(transcript);
      setSpeakingPhase("completed");
      return transcript;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not analyze speaking response.";
      setRunnerError(message);
      setSpeakingPhase("ready_to_record");
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setIsSubmittingSpeakingAudio(false);
    }
  }

  async function onAnalyzeSpeakingClick(): Promise<void> {
    try {
      await submitSpeakingAudioForAnalysis();
    } catch {
      // Error is already shown in runnerError.
    }
  }

  async function fetchNextTask(sessionId: string, sectionId: string): Promise<ItemState> {
    stopTranscriptAudio();
    setIsGeneratingContent(true);
    try {
      const result = await nextTask({ variables: { input: { sessionId, sectionInstanceId: sectionId } } });
      const next = result.data?.nextTask as ItemState | undefined;
      if (!next) {
        throw new Error("Task generation returned an empty response.");
      }
      return next;
    } finally {
      setIsGeneratingContent(false);
    }
  }

  async function ensureSectionHasFirstQuestion(sessionId: string, section: SectionState): Promise<void> {
    const alreadyLoaded = sectionItemsById[section.id] || [];
    if (alreadyLoaded.length > 0) {
      return;
    }

    const firstItem = await fetchNextTask(sessionId, section.id);
    setSectionItemsById((previous: Record<string, ItemState[]>) => ({ ...previous, [section.id]: [firstItem] }));
    setSectionCursorById((previous: Record<string, number>) => ({ ...previous, [section.id]: 0 }));
  }

  function buildResponseDraftForCurrentItem(currentItem: ItemState): ResponseDraft {
    const inputType = currentItem.promptPayload?.inputType || "text";
    if (inputType === "choice") {
      const choice = selectedChoice.trim();
      return choice ? { choice } : { skipped: true };
    }

    const text = answerText.trim();
    return text ? { text } : { skipped: true };
  }

  async function persistCurrentAnswer(overrideDraft?: ResponseDraft): Promise<void> {
    if (!session || !activeSection || !item) {
      return;
    }

    let responseDraft = overrideDraft;
    if (!responseDraft && activeSection.sectionType === "SPEAKING" && item.promptPayload?.inputType === "text") {
      const text = answerText.trim();
      if (text) {
        responseDraft = { text };
      } else if (recordedAudioBlob && recordedAudioBlob.size > 0) {
        const transcript = await submitSpeakingAudioForAnalysis(recordedAudioBlob);
        responseDraft = transcript.trim() ? { text: transcript.trim() } : { skipped: true };
      } else {
        throw new Error("No speaking response was captured. Record and analyze your answer before continuing.");
      }
    }

    responseDraft = responseDraft || buildResponseDraftForCurrentItem(item);
    setResponsesByItemId((previous: Record<string, ResponseDraft>) => ({ ...previous, [item.id]: responseDraft }));

    await saveAnswerMutation({
      variables: {
        input: {
          sessionId: session.id,
          sectionInstanceId: activeSection.id,
          testItemId: item.id,
          responsePayload: responseDraft,
        },
      },
    });
  }

  async function onStartSession(): Promise<void> {
    setRunnerError("");
    setSessionComplete(false);
    setFinalReport(null);
    setIsSectionMenuOpen(false);

    try {
      const result = await startSession();
      const nextSession = result.data?.startSession as SessionState | undefined;
      if (!nextSession) {
        throw new Error("Could not start session.");
      }

      const orderedSections = (nextSession.sections || []).slice().sort((a, b) => a.orderIndex - b.orderIndex);
      if (orderedSections.length === 0) {
        throw new Error("Session was created without sections.");
      }

      setSession(nextSession);
      setSections(orderedSections);
      setCurrentSectionIndex(0);
      setSectionItemsById({});
      setSectionCursorById({});
      setResponsesByItemId({});
      setSelectedChoice("");
      setAnswerText("");
      setViewMode("test");

      await ensureSectionHasFirstQuestion(nextSession.id, orderedSections[0]);
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not start the test session.");
    }
  }

  async function completeSessionAndLoadReport(timeoutReached: boolean): Promise<void> {
    if (!session) {
      return;
    }

    setSessionComplete(true);
    stopTranscriptAudio();

    await completeSession({ variables: { sessionId: session.id } });
    const reportResult = await generateReportMutation({ variables: { sessionId: session.id } });
    const reportRaw = reportResult.data?.generateReport?.reportJson;
    setFinalReport(asFinalReportPayload(reportRaw));
    await refetchRecentResults();

    if (timeoutReached) {
      setRunnerError("Time is over. The test is now completed.");
    }
  }

  async function persistCurrentAnswerForPartialEvaluation(): Promise<void> {
    if (!session || !activeSection || !item) {
      return;
    }

    if (activeSection.sectionType === "SPEAKING" && item.promptPayload?.inputType === "text") {
      const text = answerText.trim();
      if (text) {
        await persistCurrentAnswer({ text });
        return;
      }

      if (recordedAudioBlob && recordedAudioBlob.size > 0) {
        try {
          const transcript = await submitSpeakingAudioForAnalysis(recordedAudioBlob);
          const normalizedTranscript = transcript.trim();
          await persistCurrentAnswer(normalizedTranscript ? { text: normalizedTranscript } : { skipped: true });
          return;
        } catch {
          await persistCurrentAnswer({ skipped: true });
          return;
        }
      }

      await persistCurrentAnswer({ skipped: true });
      return;
    }

    await persistCurrentAnswer(buildResponseDraftForCurrentItem(item));
  }

  async function onJumpToSection(targetSectionIndex: number): Promise<void> {
    if (!session || targetSectionIndex <= currentSectionIndex || targetSectionIndex >= sections.length) {
      return;
    }

    setRunnerError("");
    setIsSectionMenuOpen(false);

    try {
      await persistCurrentAnswerForPartialEvaluation();
      stopTranscriptAudio();
      setShowListeningTranscript(false);

      const targetSection = sections[targetSectionIndex];
      setCurrentSectionIndex(targetSectionIndex);
      await ensureSectionHasFirstQuestion(session.id, targetSection);
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not jump to the selected section.");
    }
  }

  async function onFinalizeCurrentEvaluation(): Promise<void> {
    if (!session || sessionComplete) {
      return;
    }

    setRunnerError("");
    setIsSectionMenuOpen(false);

    try {
      await persistCurrentAnswerForPartialEvaluation();
      await completeSessionAndLoadReport(false);
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not generate the final evaluation.");
    }
  }

  async function moveToNextSection(fromTimeout: boolean): Promise<void> {
    if (!session) {
      return;
    }

    stopTranscriptAudio();
    setShowListeningTranscript(false);
    setIsSectionMenuOpen(false);

    const nextSectionIndex = currentSectionIndex + 1;
    if (nextSectionIndex < sections.length) {
      const nextSection = sections[nextSectionIndex];
      setCurrentSectionIndex(nextSectionIndex);
      await ensureSectionHasFirstQuestion(session.id, nextSection);
      if (fromTimeout) {
        setRunnerError("Time is over for this section. Moving to the next section.");
      }
      return;
    }

    await completeSessionAndLoadReport(fromTimeout);
  }

  async function advanceAfterCurrentAnswerSaved(): Promise<void> {
    if (!session || !activeSection || !item) {
      return;
    }

    if (activeQuestionIndex < activeSectionItems.length - 1) {
      setSectionCursorById((previous: Record<string, number>) => ({
        ...previous,
        [activeSection.id]: Math.min(
          activeSectionItems.length - 1,
          (previous[activeSection.id] ?? activeQuestionIndex) + 1,
        ),
      }));
      return;
    }

    if (activeSectionItems.length < sectionLimit) {
      const fetchedItem = await fetchNextTask(session.id, activeSection.id);
      const existingIndex = activeSectionItems.findIndex((entry: ItemState) => entry.id === fetchedItem.id);

      if (existingIndex >= 0) {
        setSectionCursorById((previous: Record<string, number>) => ({ ...previous, [activeSection.id]: existingIndex }));
        return;
      }

      setSectionItemsById((previous: Record<string, ItemState[]>) => ({
        ...previous,
        [activeSection.id]: [...(previous[activeSection.id] || []), fetchedItem],
      }));
      setSectionCursorById((previous: Record<string, number>) => ({ ...previous, [activeSection.id]: activeSectionItems.length }));
      return;
    }

    await moveToNextSection(false);
  }

  async function onSpeakingQuestionTimeExpired(): Promise<void> {
    if (!session || !activeSection || !item || activeSection.sectionType !== "SPEAKING") {
      return;
    }

    setRunnerError("");
    setSpeakingPhase("processing");

    try {
      const audioBlob = await stopRecordingAndCaptureBlob();
      const transcript = await submitSpeakingAudioForAnalysis(audioBlob);
      const normalizedTranscript = transcript.trim();
      if (!normalizedTranscript) {
        throw new Error("Transcript is empty after timeout processing.");
      }

      await persistCurrentAnswer({ text: normalizedTranscript });
      await advanceAfterCurrentAnswerSaved();
    } catch (error) {
      setSpeakingPhase("ready_to_record");
      setRunnerError(
        error instanceof Error
          ? `Speaking auto-submit failed: ${error.message}`
          : "Speaking auto-submit failed due to an unknown error.",
      );
    }
  }

  async function onSectionTimeExpired(): Promise<void> {
    setSessionComplete(true);

    try {
      await persistCurrentAnswer();
    } catch (error) {
      const saveMessage = error instanceof Error
        ? error.message
        : "Could not save the current answer before timeout finalization.";
      setRunnerError(saveMessage);
    }

    try {
      await completeSessionAndLoadReport(true);
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not complete the session after timeout.");
    }
  }

  async function onPreviousQuestion(): Promise<void> {
    if (!activeSection || !item || activeQuestionIndex <= 0) {
      return;
    }

    setRunnerError("");
    try {
      await persistCurrentAnswer();
      setSectionCursorById((previous: Record<string, number>) => ({
        ...previous,
        [activeSection.id]: Math.max(0, (previous[activeSection.id] ?? activeQuestionIndex) - 1),
      }));
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not move to the previous question.");
    }
  }

  async function onNextQuestionOrSection(): Promise<void> {
    if (!session || !activeSection || !item) {
      return;
    }

    setRunnerError("");
    try {
      await persistCurrentAnswer();
      await advanceAfterCurrentAnswerSaved();
    } catch (error) {
      setRunnerError(error instanceof Error ? error.message : "Could not continue to the next step.");
    }
  }

  function downloadFinalReportPdf(): void {
    if (!finalReport) {
      return;
    }

    const lines = reportToPdfLines(finalReport, session?.id);
    const pdfBytes = buildSimplePdf(lines);
    const pdfArrayBuffer = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(pdfArrayBuffer).set(pdfBytes);
    const blob = new Blob([pdfArrayBuffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `toefl-report-${session?.id || Date.now()}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-title">Open Tests AIGen</p>
          <p className="app-subtitle">TOEFL-like simulator (independent, not ETS-affiliated)</p>
        </div>

        <div className="header-controls">
          {viewMode === "test" && session && !sessionComplete && (
            <div className="section-menu-anchor">
              <button
                className="secondary-btn menu-toggle"
                type="button"
                onClick={() => setIsSectionMenuOpen((previous: boolean) => !previous)}
                aria-expanded={isSectionMenuOpen}
                aria-label="Open section navigation menu"
              >
                ☰
              </button>

              {isSectionMenuOpen && (
                <div className="section-menu-panel">
                  <p className="section-menu-title">Evaluation Sections</p>

                  <div className="section-menu-list">
                    {sections.map((section: SectionState, index: number) => {
                      const isCurrentSection = index === currentSectionIndex;
                      const isPastSection = index < currentSectionIndex;
                      const canJumpForward = index > currentSectionIndex;

                      return (
                        <button
                          key={section.id}
                          type="button"
                          className={`section-menu-item ${isCurrentSection ? "section-menu-item-current" : ""}`.trim()}
                          onClick={() => void onJumpToSection(index)}
                          disabled={isBusy || !canJumpForward}
                        >
                          <span>{sectionDisplayName(section.sectionType)}</span>
                          <span>{isCurrentSection ? "Current" : isPastSection ? "Locked" : "Jump"}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="section-menu-actions">
                    <button type="button" className="secondary-btn" onClick={onHomeClick} disabled={isBusy}>
                      Stop Evaluation
                    </button>
                    <button type="button" onClick={() => void onFinalizeCurrentEvaluation()} disabled={isBusy}>
                      Final Evaluation
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <button className="home-button" type="button" onClick={onHomeClick}>
            HOME
          </button>

          <div className="clock-box">{showClock ? clockValue : "--:--"}</div>
        </div>
      </header>

      <main className="page">
        {viewMode === "home" && (
          <section className="home-shell">
            <article className="card home-stage">
              <div className="home-stage-header">
                <p className="home-stage-title">Open Tests AIGen</p>
                <p className="home-stage-subtitle">Configure your provider once, then start the TOEFL-like test flow.</p>
              </div>

              <div className="home-stage-body">
                <button
                  type="button"
                  className="home-start-btn"
                  onClick={onStartSession}
                  disabled={!hasConfig || creatingSession || modelBusy || savingAnswer}
                >
                  {creatingSession ? "Starting..." : "Start TOEFL Test"}
                </button>

                <button type="button" className="secondary-btn home-config-btn" onClick={() => setIsConfigModalOpen(true)}>
                  Configure OpenAI
                </button>

                <div className="home-provider-panel">
                  <p className="home-provider-label">Active provider</p>
                  <p className="home-provider-value">{activeProviderSummary}</p>
                  {activeProviderConfig?.maskedApiKey && <p className="home-provider-meta">API key: {activeProviderConfig.maskedApiKey}</p>}
                </div>

                {runnerError && <p className="error-text">{runnerError}</p>}
              </div>
            </article>

            <article className="card home-history-card">
              <div className="home-history-header">
                <p className="home-stage-title">Historical Results</p>
                <p className="home-stage-subtitle">Latest 20 evaluated attempts ordered by timestamp. Newest attempt is shown on the right.</p>
              </div>

              {historicalResults.length === 0 ? (
                <p className="task-meta">No evaluated attempts yet. Finish a test to populate the history charts.</p>
              ) : (
                <div className="history-chart-stack">
                  {SECTION_ORDER.map((sectionType: SectionType) => {
                    const sectionPoints = historicalResults.map((result: RecentResult, index: number) => ({
                      attempt: index + 1,
                      score: findRecentSectionScore(result, sectionType),
                      timestamp: formatHistoryTimestamp(result.createdAt),
                    }));

                    return (
                      <div key={sectionType} className="history-chart-card">
                        <div className="history-chart-header">
                          <h3>{sectionDisplayName(sectionType)}</h3>
                          <p className="task-meta">Band score history (1-6)</p>
                        </div>

                        <div className="history-bars" role="img" aria-label={`${sectionDisplayName(sectionType)} historical results chart`}>
                          {sectionPoints.map((point: { attempt: number; score: number | null; timestamp: string }) => (
                            <div key={`${sectionType}-${point.attempt}-${point.timestamp}`} className="history-bar-column" title={`${point.timestamp} · ${point.score ?? "No score"}`}>
                              <div className="history-bar-track">
                                {point.score !== null ? (
                                  <div className="history-bar-fill" style={{ height: `${Math.max(14, Math.round((point.score / 6) * 100))}%` }} />
                                ) : (
                                  <div className="history-bar-missing" />
                                )}
                              </div>
                              <span className="history-bar-label">{point.attempt}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </article>

            {isConfigModalOpen && (
              <div className="modal-backdrop" onClick={() => setIsConfigModalOpen(false)}>
                <article className="card config-modal" onClick={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}>
                  <div className="config-modal-header">
                    <div>
                      <h3>Configure provider</h3>
                      <p>Keep your current flow: base URL, API key, and model.</p>
                    </div>
                    <button type="button" className="secondary-btn modal-close-btn" onClick={() => setIsConfigModalOpen(false)}>
                      Close
                    </button>
                  </div>

                  <div className="config-form-grid">
                    <label>
                      Base URL (openai Compatible .../openai/v1)
                      <input value={baseUrl} onChange={(event: ChangeEvent<HTMLInputElement>) => setBaseUrl(event.target.value)} />
                    </label>
                    <label>
                      API Key
                      <input value={apiKey} onChange={(event: ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value)} />
                    </label>
                    <label>
                      Model
                      <input value={model} onChange={(event: ChangeEvent<HTMLInputElement>) => setModel(event.target.value)} />
                    </label>
                  </div>

                  <div className="config-modal-actions">
                    <button type="button" onClick={onSaveConfig} disabled={savingConfig}>
                      {savingConfig ? "Saving..." : "Save Config"}
                    </button>
                  </div>
                </article>
              </div>
            )}
          </section>
        )}

        {viewMode === "test" && (
          <>
            <section className="card status-card">
              <p>
                Session: <strong>{session?.id || "-"}</strong>
              </p>
              <p>
                Section: <strong>{sectionLabel}</strong>
              </p>
              <p>
                Question: <strong>{questionOrdinal}/{sectionLimit}</strong>
              </p>
              <p>
                Status: <strong>{sessionComplete ? "COMPLETED" : session?.status || "IN_PROGRESS"}</strong>
              </p>
            </section>

            {modelBusy && (
              <section className="card loading-card">
                <div className="loading-head">
                  <span className="loading-spinner" aria-hidden="true" />
                  <p className="task-meta">{loadingCopy}</p>
                </div>
                <div className="loading-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={generationProgress}>
                  <div className="loading-fill" style={{ width: `${generationProgress}%` }} />
                </div>
              </section>
            )}

            {runnerError && <p className="error-text">{runnerError}</p>}
            {sessionComplete && <p className="success-text">Session completed. Final evaluation is shown below.</p>}

            {sessionComplete && !finalReport && (
              <section className="card loading-card final-evaluation-loading-card">
                <div className="loading-head">
                  <span className="loading-spinner" aria-hidden="true" />
                  <p className="task-meta">Preparing your final evaluation...</p>
                </div>
                <div className="loading-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-label="Final evaluation loading">
                  <div className="loading-fill loading-fill-indeterminate" />
                </div>
              </section>
            )}

            {sessionComplete && finalReport && (
              <section className="card report-card">
                <h3>Final Evaluation</h3>
                <p className="task-meta">
                  Overall (1-6): <strong>{finalReport.overallScore ?? "-"}</strong>
                  {" | "}
                  Estimated TOEFL (0-120): <strong>{finalReport.overallScore0to120Estimate ?? "-"}</strong>
                </p>

                {finalReport.summary && <p>{finalReport.summary}</p>}

                <div className="home-actions">
                  <button type="button" className="secondary-btn" onClick={downloadFinalReportPdf}>
                    Download PDF Report
                  </button>
                </div>

                {finalReport.sectionScores.length > 0 && (
                  <ul>
                    {finalReport.sectionScores.map((score: SectionScorePayload) => (
                      <li key={`${score.sectionType}-${score.sectionId || score.score}`}>
                        {score.sectionType}: {score.score}
                      </li>
                    ))}
                  </ul>
                )}

                {readingListeningAccuracy && (
                  <p className="task-meta">
                    Reading + Listening objective accuracy: <strong>{readingListeningAccuracy.correct}/{readingListeningAccuracy.total}</strong>
                    {" "}
                    ({readingListeningAccuracy.percentage}%)
                  </p>
                )}

                {finalReport.strengths.length > 0 && (
                  <p>
                    <strong>Strengths:</strong> {finalReport.strengths.join(" | ")}
                  </p>
                )}
                {finalReport.weaknesses.length > 0 && (
                  <p>
                    <strong>Weaknesses:</strong> {finalReport.weaknesses.join(" | ")}
                  </p>
                )}
                {finalReport.improvements.length > 0 && (
                  <p>
                    <strong>Improvements:</strong> {finalReport.improvements.join(" | ")}
                  </p>
                )}

                {finalReport.answerReview.length > 0 && (
                  <div className="report-answer-grid">
                    <h4>Reading & Listening Answer Review</h4>
                    {finalReport.answerReview.map((entry: AnswerReviewPayload, index: number) => (
                      <article
                        key={`${entry.sectionType}-${entry.questionIndex}-${index}`}
                        className={`answer-review-card ${entry.isCorrect ? "answer-correct" : "answer-incorrect"}`}
                      >
                        <p className="task-meta">
                          {entry.sectionType} Q{entry.questionIndex}
                          {entry.topic ? ` | Topic: ${entry.topic}` : ""}
                        </p>
                        <p>
                          <strong>Question:</strong> {entry.question}
                        </p>
                        <p>
                          <strong>Your answer:</strong> {entry.userAnswer || "(No answer)"}
                        </p>
                        <p>
                          <strong>Correct answer:</strong> {entry.correctAnswer || "(Unavailable)"}
                        </p>
                        <p>
                          <strong>Why:</strong> {entry.explanation || "No explanation provided."}
                        </p>
                      </article>
                    ))}
                  </div>
                )}

                {finalReport.speakingInsights.length > 0 && (
                  <div className="report-insights-grid">
                    <h4>Speaking Diagnostics + B2/C1 Examples</h4>
                    {finalReport.speakingInsights.map((insight: ConstructedInsightPayload) => (
                      <article key={insight.testItemId} className="insight-card">
                        <p className="task-meta">
                          Speaking task {insight.testItemId}
                          {typeof insight.estimatedBand === "number" ? ` | Estimated band: ${insight.estimatedBand}` : ""}
                        </p>
                        {typeof insight.estimatedBand === "number" && (
                          <div className="band-track" aria-hidden="true">
                            <div className="band-fill" style={{ width: `${Math.round((insight.estimatedBand / 6) * 100)}%` }} />
                          </div>
                        )}
                        <div className="stimulus-scroll">
                          <h4>Prompt</h4>
                          <p>{asDisplayText(insight.prompt) || "-"}</p>
                        </div>
                        <div className="stimulus-scroll">
                          <h4>Your response</h4>
                          <p>{asDisplayText(insight.userResponse) || "(No response submitted)"}</p>
                        </div>

                        {insight.faults.length > 0 && (
                          <ul>
                            {insight.faults.map((fault: FaultInsightPayload, faultIndex: number) => (
                              <li key={`${insight.testItemId}-fault-${faultIndex}`}>
                                <strong>{fault.category}:</strong> {fault.issue} | Evidence: {fault.evidence} | Improve: {fault.improvement}
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="example-grid">
                          <div className="stimulus-scroll">
                            <h4>B2 Upper example</h4>
                            <p>{asDisplayText(insight.b2Example) || "No B2 example available."}</p>
                          </div>
                          <div className="stimulus-scroll">
                            <h4>C1 example</h4>
                            <p>{asDisplayText(insight.c1Example) || "No C1 example available."}</p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {finalReport.writingInsights.length > 0 && (
                  <div className="report-insights-grid">
                    <h4>Writing Diagnostics + B2/C1 Examples</h4>
                    {finalReport.writingInsights.map((insight: ConstructedInsightPayload) => (
                      <article key={insight.testItemId} className="insight-card">
                        <p className="task-meta">
                          Writing task {insight.testItemId}
                          {typeof insight.estimatedBand === "number" ? ` | Estimated band: ${insight.estimatedBand}` : ""}
                        </p>
                        {typeof insight.estimatedBand === "number" && (
                          <div className="band-track" aria-hidden="true">
                            <div className="band-fill" style={{ width: `${Math.round((insight.estimatedBand / 6) * 100)}%` }} />
                          </div>
                        )}
                        <div className="stimulus-scroll">
                          <h4>Prompt</h4>
                          <p>{asDisplayText(insight.prompt) || "-"}</p>
                        </div>
                        <div className="stimulus-scroll">
                          <h4>Your response</h4>
                          <p>{asDisplayText(insight.userResponse) || "(No response submitted)"}</p>
                        </div>

                        {insight.faults.length > 0 && (
                          <ul>
                            {insight.faults.map((fault: FaultInsightPayload, faultIndex: number) => (
                              <li key={`${insight.testItemId}-fault-${faultIndex}`}>
                                <strong>{fault.category}:</strong> {fault.issue} | Evidence: {fault.evidence} | Improve: {fault.improvement}
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="example-grid">
                          <div className="stimulus-scroll">
                            <h4>B2 Upper example</h4>
                            <p>{asDisplayText(insight.b2Example) || "No B2 example available."}</p>
                          </div>
                          <div className="stimulus-scroll">
                            <h4>C1 example</h4>
                            <p>{asDisplayText(insight.c1Example) || "No C1 example available."}</p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {!sessionComplete && item && (
              <section className="exam-layout">
                <article className="pane stimulus-pane">
                  <h3>Section Material</h3>
                  <p>{asDisplayText(item.promptPayload?.instruction) || "Follow the instructions carefully."}</p>

                  {sectionLabel === "READING" && (
                    <>
                      <p className="task-meta">
                        Topic: {asString(item.promptPayload?.topic) || "-"} | Passage words: {passageWordCount}
                      </p>
                      <div className="stimulus-scroll">
                        <h4>Passage</h4>
                        <p>{asDisplayText(item.promptPayload?.passage)}</p>
                      </div>
                    </>
                  )}

                  {sectionLabel === "LISTENING" && (
                    <>
                      <p className="task-meta">
                        Stimulus: {stimulusType} | Transcript words: {transcriptWordCount} | Est. length: {formatDuration(estimatedDurationSeconds)}
                      </p>

                      <div className="audio-controls">
                        <button
                          type="button"
                          onClick={playListeningStimulusAudio}
                          disabled={isSpeaking || (listeningPlaybackQueue.length === 0 && !asString(item.promptPayload?.transcript).trim())}
                        >
                          {isSpeaking
                            ? "Playing..."
                            : listeningPlaybackQueue.length > 1
                              ? `Play Audio Sequence (${listeningPlaybackQueue.length} chunks)`
                              : "Play Audio"}
                        </button>
                        <button type="button" className="secondary-btn" onClick={stopTranscriptAudio} disabled={!isSpeaking}>
                          Stop
                        </button>
                      </div>

                      {isSpeaking && listeningPlaybackQueue.length > 0 && (
                        <p className="task-meta">
                          Playing chunk {activeAudioChunkIndex + 1}/{listeningPlaybackQueue.length}
                          {activeChunk?.voice ? ` | Voice: ${activeChunk.voice}` : ""}
                          {activeChunk?.gender ? ` | Gender: ${activeChunk.gender}` : ""}
                        </p>
                      )}

                      {listeningPlaybackQueue.length > 1 && (
                        <p className="task-meta">
                          Chunked playback is AI-generated in sequence with persistent voice per actor.
                        </p>
                      )}

                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => setShowListeningTranscript((previous: boolean) => !previous)}
                      >
                        {showListeningTranscript ? "Hide Transcript" : "Show Transcript"}
                      </button>

                      {showListeningTranscript && (
                        <div className="stimulus-scroll">
                          <h4>Transcript</h4>
                          <p>{asDisplayText(item.promptPayload?.transcript)}</p>
                        </div>
                      )}
                    </>
                  )}

                  {sectionLabel === "SPEAKING" && (
                    <>
                      <div className="stimulus-scroll">
                        <h4>Speaking Prompt</h4>
                        <p>{asDisplayText(item.promptPayload?.speakingPrompt)}</p>
                      </div>

                      <p className="task-meta">
                        Per-question timer: Prep {speakingPreparationSeconds}s + Response {speakingResponseSeconds}s = {formatDuration(speakingTimeLimitSeconds)}
                      </p>
                      <p className="task-meta">Speaking stage: {speakingPhaseLabel}</p>
                      {speakingQuestionSecondsRemaining !== null && (
                        <p className="task-meta">{speakingTimerLabel}: {formatDuration(speakingQuestionSecondsRemaining)}</p>
                      )}

                      <div className="audio-controls">
                        <button
                          type="button"
                          onClick={startRecordingSpeakingAudio}
                          disabled={
                            isRecording ||
                            isBusy ||
                            speakingPhase !== "ready_to_record" ||
                            (speakingQuestionSecondsRemaining !== null && speakingQuestionSecondsRemaining <= 0)
                          }
                        >
                          {isRecording ? "Recording..." : "Start Recording"}
                        </button>
                        <button type="button" className="secondary-btn" onClick={stopRecordingSpeakingAudio} disabled={!isRecording}>
                          Stop Recording
                        </button>
                        <button
                          type="button"
                          onClick={onAnalyzeSpeakingClick}
                          disabled={!recordedAudioBlob || isRecording || isSubmittingSpeakingAudio || isBusy}
                        >
                          {isSubmittingSpeakingAudio ? "Analyzing..." : "Analyze Speaking"}
                        </button>
                      </div>

                      {recordedAudioBlob && !isRecording && (
                        <p className="task-meta">Recorded response ready ({Math.max(1, Math.round(recordedAudioBlob.size / 1024))} KB).</p>
                      )}
                      {speakingAnalysisModel && <p className="task-meta">Analysis model: {speakingAnalysisModel}</p>}

                      {speakingTranscript && (
                        <div className="stimulus-scroll">
                          <h4>Transcript</h4>
                          <p>{asDisplayText(speakingTranscript)}</p>
                        </div>
                      )}

                      {speakingAnalysis && (
                        <div className="stimulus-scroll">
                          <h4>AI Speaking Analysis</h4>
                          <p>{asDisplayText(speakingAnalysis)}</p>
                        </div>
                      )}
                    </>
                  )}

                  {sectionLabel === "WRITING" && (
                    <div className="stimulus-scroll">
                      <h4>Writing Prompt</h4>
                      <p>{asDisplayText(item.promptPayload?.writingPrompt)}</p>
                    </div>
                  )}
                </article>

                <article className="pane question-pane">
                  <p className="question-index">Question {questionOrdinal} of {sectionLimit}</p>
                  <p className="question-type">Type: {questionType}</p>

                  <h3 className="question-text">
                    {asString(item.promptPayload?.question) || "Respond to the prompt in this section."}
                  </h3>

                  {item.promptPayload?.inputType === "choice" ? (
                    <fieldset className="choice-list">
                      <legend>Select one answer</legend>
                      {options.map((choice) => (
                        <label key={choice} className="choice-item">
                          <input
                            type="radio"
                            name="task-choice"
                            value={choice}
                            checked={selectedChoice === choice}
                            onChange={(event: ChangeEvent<HTMLInputElement>) => setSelectedChoice(event.target.value)}
                          />
                          <span>{choice}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <>
                      <textarea
                        rows={sectionLabel === "WRITING" ? 12 : 7}
                        value={answerText}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setAnswerText(event.target.value)}
                        placeholder={
                          sectionLabel === "SPEAKING"
                            ? "Your transcribed response will appear here after speaking analysis (you can edit it)."
                            : "Write your answer..."
                        }
                      />
                      {isWritingTextResponse && <p className="word-counter">Word count: {writingResponseWordCount}</p>}
                    </>
                  )}

                  <div className="question-nav">
                    <button type="button" className="secondary-btn" onClick={onPreviousQuestion} disabled={isBusy || isFirstQuestion}>
                      Previous
                    </button>
                    <button type="button" onClick={onNextQuestionOrSection} disabled={isBusy}>
                      {isBusy ? "Processing..." : nextActionLabel}
                    </button>
                  </div>

                  <p className="section-note">
                    Navigation rule: you can move back and forth only within this section. Once you move to the next section,
                    you cannot return.
                  </p>
                </article>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
