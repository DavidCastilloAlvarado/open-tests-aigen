import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, SectionType } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { ProviderConfigService } from "./provider-config.service";

type ObjectiveAnswerReview = {
  sectionType: "READING" | "LISTENING";
  questionIndex: number;
  question: string;
  userAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  explanation: string;
  topic: string;
};

type ConstructedTaskInput = {
  testItemId: string;
  sectionId: string;
  sectionType: "SPEAKING" | "WRITING";
  prompt: string;
  userResponse: string;
  itemContext: string;
};

type FaultInsight = {
  category: string;
  issue: string;
  evidence: string;
  improvement: string;
};

type ConstructedTaskInsight = {
  testItemId: string;
  sectionType: "SPEAKING" | "WRITING";
  prompt: string;
  userResponse: string;
  estimatedBand: number | null;
  strengths: string[];
  weaknesses: string[];
  faults: FaultInsight[];
  b2Example: string;
  c1Example: string;
};

type AiInsights = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
  speakingInsights: ConstructedTaskInsight[];
  writingInsights: ConstructedTaskInsight[];
};

type ActiveProviderConfig = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerConfigService: ProviderConfigService,
  ) {}

  async listRecentResults(limit = 20) {
    const take = Math.min(Math.max(1, Math.trunc(limit || 20)), 20);
    const reports = await this.prisma.analysisReport.findMany({
      take,
      orderBy: { createdAt: "desc" },
      include: {
        session: {
          include: {
            sections: {
              orderBy: { orderIndex: "asc" },
            },
          },
        },
      },
    });

    return reports.map((report: any) => ({
      reportId: report.id,
      sessionId: report.sessionId,
      createdAt: report.createdAt.toISOString(),
      overallScore1to6: report.session.overallScore1to6,
      overallScore0to120: report.session.overallScore0to120,
      sectionScores: report.session.sections
        .filter((section: any) => typeof section.score1to6 === "number")
        .map((section: any) => ({
          sectionType: section.sectionType,
          score: section.score1to6 as number,
        })),
    }));
  }

  async generateReport(sessionId: string) {
    const session = await this.prisma.testSession.findUnique({
      where: { id: sessionId },
      include: {
        sections: {
          orderBy: { orderIndex: "asc" },
          include: {
            items: {
              orderBy: { createdAt: "asc" },
              include: {
                answers: {
                  orderBy: { submittedAt: "desc" },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException("Session not found");
    }

    const objectiveReview = this.buildObjectiveAnswerReview(session.sections);
    const constructedTasks = this.buildConstructedTaskInputs(session.sections);
    const aiInsights = await this.generateAiInsights(constructedTasks);

    const sectionScores = this.computeSectionScores({
      sections: session.sections,
      objectiveReview,
      speakingInsights: aiInsights.speakingInsights,
      writingInsights: aiInsights.writingInsights,
    });

    const rawAverage = sectionScores.reduce((sum, section) => sum + section.score, 0) / Math.max(sectionScores.length, 1);
    const overallScore = this.roundHalf(rawAverage);
    const overallScore0to120Estimate = Math.round((overallScore / 6) * 120);

    const objectiveWeakness = this.objectiveWeaknessInsight(objectiveReview);

    const strengths = this.uniqueNonEmpty([
      ...aiInsights.strengths,
      objectiveReview.length > 0 ? "Objective answer review completed for reading/listening tasks" : "",
    ]).slice(0, 8);
    const weaknesses = this.uniqueNonEmpty([...aiInsights.weaknesses, objectiveWeakness]).slice(0, 8);
    const improvements = this.uniqueNonEmpty([...aiInsights.improvements, this.objectiveImprovementTip(objectiveReview)]).slice(0, 8);

    const reportJson: Prisma.InputJsonObject = {
      scale: "1-6",
      summary:
        aiInsights.summary ||
        "This report combines objective reading/listening checks with AI-generated speaking/writing diagnostics.",
      sectionScores: sectionScores as unknown as Prisma.InputJsonValue,
      overallScore,
      overallScore0to120Estimate,
      strengths,
      weaknesses,
      improvements,
      answerReview: objectiveReview as unknown as Prisma.InputJsonValue,
      speakingInsights: aiInsights.speakingInsights as unknown as Prisma.InputJsonValue,
      writingInsights: aiInsights.writingInsights as unknown as Prisma.InputJsonValue,
      generatedAt: new Date().toISOString(),
      disclaimer: "TOEFL-like simulator. Not affiliated with ETS.",
    };

    await this.prisma.$transaction([
      ...sectionScores.map((section) =>
        this.prisma.sectionInstance.update({
          where: { id: section.sectionId },
          data: { score1to6: section.score },
        }),
      ),
      this.prisma.testSession.update({
        where: { id: sessionId },
        data: {
          overallScore1to6: overallScore,
          overallScore0to120: overallScore0to120Estimate,
        },
      }),
    ]);

    return this.prisma.analysisReport.upsert({
      where: { sessionId },
      update: { reportJson },
      create: {
        sessionId,
        reportJson,
        pdfUrl: null,
      },
    });
  }

  private buildObjectiveAnswerReview(
    sections: Array<{
      sectionType: SectionType;
      items: Array<{
        promptPayload: Prisma.JsonValue;
        metadataJson: Prisma.JsonValue;
        answers: Array<{ responsePayload: Prisma.JsonValue }>;
      }>;
    }>,
  ): ObjectiveAnswerReview[] {
    const reviews: ObjectiveAnswerReview[] = [];

    for (const section of sections) {
      if (section.sectionType !== "READING" && section.sectionType !== "LISTENING") {
        continue;
      }

      for (let index = 0; index < section.items.length; index += 1) {
        const item = section.items[index];
        const payload = this.asObject(item.promptPayload) || {};
        const metadata = this.asObject(item.metadataJson) || {};
        const responsePayload = this.asObject(item.answers[0]?.responsePayload) || {};
        const options = this.readStringArray(payload.options);
        const correctAnswer = this.resolveCorrectAnswer(payload, options);
        const userAnswer =
          this.readString(responsePayload.choice) ||
          this.readString(responsePayload.answer) ||
          this.readString(responsePayload.text) ||
          "";
        const explanation =
          this.readString(payload.answerExplanation) ||
          this.readString(payload.explanation) ||
          (correctAnswer
            ? `The best supported option is \"${correctAnswer}\" based on the stimulus evidence.`
            : "Answer key unavailable for this item.");

        reviews.push({
          sectionType: section.sectionType,
          questionIndex: this.readNumber(payload.questionIndex) || this.readNumber(metadata.questionIndex) || index + 1,
          question: this.readString(payload.question) || `Question ${index + 1}`,
          userAnswer,
          correctAnswer,
          isCorrect:
            userAnswer.length > 0 && correctAnswer.length > 0
              ? this.normalizeChoice(userAnswer) === this.normalizeChoice(correctAnswer)
              : false,
          explanation,
          topic: this.readString(payload.topic) || this.readString(metadata.topic),
        });
      }
    }

    return reviews.sort((a, b) => {
      if (a.sectionType !== b.sectionType) {
        return a.sectionType.localeCompare(b.sectionType);
      }
      return a.questionIndex - b.questionIndex;
    });
  }

  private buildConstructedTaskInputs(
    sections: Array<{
      id: string;
      sectionType: SectionType;
      items: Array<{
        id: string;
        taskType: string;
        promptPayload: Prisma.JsonValue;
        metadataJson: Prisma.JsonValue;
        answers: Array<{ responsePayload: Prisma.JsonValue }>;
      }>;
    }>,
  ): ConstructedTaskInput[] {
    const tasks: ConstructedTaskInput[] = [];

    for (const section of sections) {
      if (section.sectionType !== "SPEAKING" && section.sectionType !== "WRITING") {
        continue;
      }

      for (const item of section.items) {
        const payload = this.asObject(item.promptPayload) || {};
        const metadata = this.asObject(item.metadataJson) || {};
        const taskType = this.readString(item.taskType);
        const responsePayload = this.asObject(item.answers[0]?.responsePayload) || {};
        const itemContext = this.serializeItemContext({
          taskType,
          promptPayload: payload,
          metadataJson: metadata,
        });
        const prompt =
          section.sectionType === "SPEAKING"
            ? this.readString(payload.speakingPrompt) || this.readString(payload.question) || this.readString(payload.instruction)
            : this.readString(payload.writingPrompt) || this.readString(payload.question) || this.readString(payload.instruction);
        const userResponse =
          this.readString(responsePayload.text) ||
          this.readString(responsePayload.transcript) ||
          this.readString(responsePayload.answer) ||
          this.readString(responsePayload.choice);

        tasks.push({
          testItemId: item.id,
          sectionId: section.id,
          sectionType: section.sectionType,
          prompt: prompt || "Response task prompt",
          userResponse,
          itemContext,
        });
      }
    }

    return tasks;
  }

  private async generateAiInsights(tasks: ConstructedTaskInput[]): Promise<AiInsights> {
    if (tasks.length === 0) {
      return {
        summary: "No speaking or writing responses were found for deep analysis.",
        strengths: [],
        weaknesses: [],
        improvements: [],
        speakingInsights: [],
        writingInsights: [],
      };
    }

    const activeConfig = await this.providerConfigService.getActiveWithApiKey();
    if (!activeConfig) {
      throw new Error("Active LLM provider configuration is required to generate report insights.");
    }

    const endpoint = `${this.normalizeTextProviderBaseUrl(activeConfig.baseUrl)}/responses`;
    const model = activeConfig.model || "gpt-4.1-mini";
    const reasoningEffort = this.reasoningEffortForModel(model, "high");
    const speakingTaskIds = tasks.filter((task) => task.sectionType === "SPEAKING").map((task) => task.testItemId);
    const writingTaskIds = tasks.filter((task) => task.sectionType === "WRITING").map((task) => task.testItemId);
    const taskMap = new Map(tasks.map((task) => [task.testItemId, task]));
    const requestStartedAt = Date.now();
    this.logger.log(
      `[OpenAI Request] report_insights endpoint=${endpoint} model=${model} tasks=${tasks.length} speaking=${speakingTaskIds.length} writing=${writingTaskIds.length}`,
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${activeConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "You are a strict TOEFL evaluator. Output ONLY valid JSON without markdown fences. Be specific, evidence-based, and practical.",
          },
          {
            role: "user",
            content: [
              "Analyze these TOEFL-like speaking and writing responses.",
              "Return strict JSON with keys: summary, strengths, weaknesses, improvements, speakingInsights, writingInsights.",
              "Each insight object must include: testItemId, estimatedBand, strengths, weaknesses, faults.",
              "faults must be an array of objects with keys: category, issue, evidence, improvement.",
              "Band scale is 1-6 and can use 0.5 increments.",
              "Do not mix sections: speakingInsights must evaluate only SPEAKING tasks, and writingInsights must evaluate only WRITING tasks.",
              "For each insight, keep prompt and userResponse aligned to the exact matching testItemId from the tasks payload.",
              "Use the full itemContext field for each task while evaluating strengths, weaknesses, and faults.",
              "Avoid generic one-sentence feedback bullets.",
              `Speaking task IDs that must appear: ${JSON.stringify(speakingTaskIds)}.`,
              `Writing task IDs that must appear: ${JSON.stringify(writingTaskIds)}.`,
              `Tasks payload: ${JSON.stringify(tasks)}`,
            ].join("\n\n"),
          },
        ],
        reasoning: {
          effort: reasoningEffort,
        },
        text: {
          format: {
            type: "text",
          },
        },
      }),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown network error";
      this.logger.warn(`[OpenAI Request] report_insights network_error endpoint=${endpoint} message=${message}`);
      throw new Error(`Report insight generation request failed: ${message}`);
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      this.logger.warn(
        `[OpenAI Response] report_insights status=${response.status} duration_ms=${Date.now() - requestStartedAt}`,
      );
      throw new Error(
        `Report insight generation failed with status ${response.status}: ${errorBody.slice(0, 400) || "empty response body"}`,
      );
    }
    this.logger.log(
      `[OpenAI Response] report_insights success status=${response.status} duration_ms=${Date.now() - requestStartedAt}`,
    );

    const payload = (await response.json().catch(() => null)) as unknown;
    const content = this.extractResponsesOutputText(payload);
    const parsed = this.parseObjectFromText(content);
    if (!parsed) {
      throw new Error("Report insight generation returned non-JSON or malformed JSON content.");
    }

    const parsedSpeaking = this.readObjectArray(parsed.speakingInsights);
    const parsedWriting = this.readObjectArray(parsed.writingInsights);
    const speakingMap = new Map(parsedSpeaking.map((entry) => [this.readString(entry.testItemId), entry]));
    const writingMap = new Map(parsedWriting.map((entry) => [this.readString(entry.testItemId), entry]));

    const missingSpeakingIds = speakingTaskIds.filter((id) => !speakingMap.has(id));
    if (missingSpeakingIds.length > 0) {
      throw new Error(`LLM insight output is missing speaking task IDs: ${missingSpeakingIds.join(", ")}`);
    }
    const missingWritingIds = writingTaskIds.filter((id) => !writingMap.has(id));
    if (missingWritingIds.length > 0) {
      throw new Error(`LLM insight output is missing writing task IDs: ${missingWritingIds.join(", ")}`);
    }

    const speakingInsights = await this.ensureUniqueTaskExamples(
      tasks
        .filter((task) => task.sectionType === "SPEAKING")
        .map((task) => this.normalizeConstructedInsight(task, speakingMap.get(task.testItemId))),
      taskMap,
      activeConfig,
    );
    const writingInsights = await this.ensureUniqueTaskExamples(
      tasks
        .filter((task) => task.sectionType === "WRITING")
        .map((task) => this.normalizeConstructedInsight(task, writingMap.get(task.testItemId))),
      taskMap,
      activeConfig,
    );

    return {
      summary: this.readString(parsed.summary),
      strengths: this.readStringArray(parsed.strengths),
      weaknesses: this.readStringArray(parsed.weaknesses),
      improvements: this.readStringArray(parsed.improvements),
      speakingInsights,
      writingInsights,
    };
  }

  private normalizeConstructedInsight(
    task: ConstructedTaskInput,
    source: Record<string, unknown> | undefined | null,
  ): ConstructedTaskInsight {
    const strengths = source ? this.readStringArray(source.strengths) : [];
    const weaknesses = source ? this.readStringArray(source.weaknesses) : [];
    const faultsRaw = source ? this.readObjectArray(source.faults) : [];
    const faults: FaultInsight[] = faultsRaw.map((fault) => ({
      category: this.readString(fault.category) || "General",
      issue: this.readString(fault.issue) || "Needs more precision in response quality.",
      evidence: this.readString(fault.evidence) || "Evidence was not explicitly provided.",
      improvement: this.readString(fault.improvement) || "Rewrite one sentence with clearer logic and grammar.",
    }));

    const sectionLabel = task.sectionType === "SPEAKING" ? "speaking" : "writing";
    const promptSummary = task.prompt || `${sectionLabel} prompt`;

    const b2Example = "";
    const c1Example = "";

    return {
      testItemId: task.testItemId,
      sectionType: task.sectionType,
      prompt: promptSummary,
      userResponse: task.userResponse,
      estimatedBand: this.normalizeBand(this.readNumber(source?.estimatedBand)),
      strengths,
      weaknesses,
      faults,
      b2Example,
      c1Example,
    };
  }

  private ensureSectionExample(task: ConstructedTaskInput, level: "B2" | "C1", candidate: string): string {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return "";
    }

    const compact = trimmed.replace(/\s+/g, " ");

    const { minimumWords, maximumWords } = this.exampleWordRange(task, level);
    const wordCount = this.countWords(trimmed);
    if (wordCount < minimumWords || wordCount > maximumWords) {
      return "";
    }

    if (!this.isExampleAlignedWithTask(task, compact)) {
      return "";
    }

    return trimmed;
  }

  private isExampleAlignedWithTask(task: ConstructedTaskInput, example: string): boolean {
    const lower = example.toLowerCase();
    const forbiddenMetaSnippets = [
      "this response addresses the task prompt",
      "regarding the prompt",
      "the most persuasive response is the one",
      "a c1-level toefl-style response",
      "the best toefl-style response combines",
      "a strong response should",
      "the writer should",
      "this essay should",
      "to answer this prompt",
      "in this specific task",
      "this speaking task",
      "this writing task",
      "the following response",
      "this response should",
    ];

    if (forbiddenMetaSnippets.some((snippet) => lower.includes(snippet))) {
      return false;
    }

    const promptKeywords = this.extractPromptKeywords(task.prompt);
    if (promptKeywords.length === 0) {
      return true;
    }

    const matchedKeywords = promptKeywords.filter((keyword) => lower.includes(keyword));
    const minimumMatches = promptKeywords.length >= 4 ? 2 : 1;
    if (matchedKeywords.length < minimumMatches) {
      return false;
    }

    const asksOpinion = this.promptRequestsOpinion(task.prompt);
    if (asksOpinion) {
      const stanceSignals = ["i believe", "i think", "in my view", "from my perspective", "i support", "i agree", "i disagree"];
      if (!stanceSignals.some((signal) => lower.includes(signal))) {
        return false;
      }
    }

    return true;
  }

  private async ensureUniqueTaskExamples(
    insights: ConstructedTaskInsight[],
    taskMap: Map<string, ConstructedTaskInput>,
    activeConfig: ActiveProviderConfig,
  ): Promise<ConstructedTaskInsight[]> {
    const seenB2Keys = new Set<string>();
    const seenC1Keys = new Set<string>();
    const seenB2Examples: string[] = [];
    const seenC1Examples: string[] = [];
    const resolvedInsights: ConstructedTaskInsight[] = [];

    for (const insight of insights) {
      const originalTask = taskMap.get(insight.testItemId);
      if (!originalTask) {
        throw new Error(`Missing task context for insight ${insight.testItemId}.`);
      }

      const task: ConstructedTaskInput = {
        ...originalTask,
        prompt: insight.prompt || originalTask.prompt || "Response task prompt",
      };

      const b2Example = await this.ensureUniqueExampleForTask({
        task,
        level: "B2",
        initialExample: insight.b2Example,
        seenKeys: seenB2Keys,
        seenExamples: seenB2Examples,
        activeConfig,
      });
      const c1Example = await this.ensureUniqueExampleForTask({
        task,
        level: "C1",
        initialExample: insight.c1Example,
        seenKeys: seenC1Keys,
        seenExamples: seenC1Examples,
        activeConfig,
      });

      resolvedInsights.push({
        ...insight,
        b2Example,
        c1Example,
      });
    }

    return resolvedInsights;
  }

  private async ensureUniqueExampleForTask(args: {
    task: ConstructedTaskInput;
    level: "B2" | "C1";
    initialExample: string;
    seenKeys: Set<string>;
    seenExamples: string[];
    activeConfig: ActiveProviderConfig;
  }): Promise<string> {
    const existing = this.ensureSectionExample(args.task, args.level, args.initialExample);
    const existingKey = this.normalizeExampleKey(existing);

    if (existing && existingKey && !args.seenKeys.has(existingKey)) {
      args.seenKeys.add(existingKey);
      args.seenExamples.push(existing);
      return existing;
    }

    let avoidExamples = args.seenExamples.slice(-3);
    if (existing) {
      avoidExamples = [...avoidExamples, existing].slice(-4);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const generated = await this.generateSectionExampleForTask({
        task: args.task,
        level: args.level,
        activeConfig: args.activeConfig,
        avoidExamples,
      });
      const validated = this.ensureSectionExample(args.task, args.level, generated);
      if (!validated) {
        continue;
      }

      const generatedKey = this.normalizeExampleKey(validated);
      if (!generatedKey || args.seenKeys.has(generatedKey)) {
        avoidExamples = [...avoidExamples, validated].slice(-4);
        continue;
      }

      args.seenKeys.add(generatedKey);
      args.seenExamples.push(validated);
      return validated;
    }

    throw new Error(`Unable to generate a valid ${args.level} example for task ${args.task.testItemId}.`);
  }

  private detectPromptIntent(prompt: string): "integrated_summary" | "pro_con" | "choice" | "agree_disagree" | "general" {
    const lowerPrompt = prompt.toLowerCase();

    const isSummaryEvaluationPrompt =
      lowerPrompt.includes("summarize") ||
      lowerPrompt.includes("main concern") ||
      lowerPrompt.includes("according to the lecture") ||
      lowerPrompt.includes("according to the conversation") ||
      lowerPrompt.includes("advisor suggests") ||
      lowerPrompt.includes("the student explains");
    if (isSummaryEvaluationPrompt) {
      return "integrated_summary";
    }

    const isProConPrompt =
      lowerPrompt.includes("advantages and disadvantages") ||
      lowerPrompt.includes("benefits and drawbacks") ||
      lowerPrompt.includes("pros and cons") ||
      lowerPrompt.includes("both perspectives") ||
      lowerPrompt.includes("both sides") ||
      lowerPrompt.includes("outweigh");
    if (isProConPrompt) {
      return "pro_con";
    }

    const isChoicePrompt =
      lowerPrompt.includes("which option") ||
      lowerPrompt.includes("which one") ||
      lowerPrompt.includes("choose between") ||
      lowerPrompt.includes("would you rather") ||
      lowerPrompt.includes("prefer") ||
      lowerPrompt.includes("better choice");
    if (isChoicePrompt) {
      return "choice";
    }

    if (this.promptRequestsOpinion(prompt) || lowerPrompt.includes("do you support")) {
      return "agree_disagree";
    }

    return "general";
  }

  private promptRequestsOpinion(prompt: string): boolean {
    const lowerPrompt = prompt.toLowerCase();
    return (
      lowerPrompt.includes("agree or disagree") ||
      lowerPrompt.includes("do you agree") ||
      lowerPrompt.includes("do you think") ||
      lowerPrompt.includes("state your opinion") ||
      lowerPrompt.includes("what is your opinion") ||
      lowerPrompt.includes("to what extent") ||
      lowerPrompt.includes("do you support")
    );
  }

  private readSecondsLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value);
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.round(parsed);
      }
    }
    return null;
  }

  private extractSpeakingSecondsFromItemContext(itemContext: string): number | null {
    const context = this.safeParseObject(itemContext);
    if (!context) {
      return null;
    }

    const promptPayload = this.asObject(context.promptPayload) || {};
    const responseTimeSeconds = this.readSecondsLike(promptPayload.responseTimeSeconds);
    if (responseTimeSeconds !== null) {
      return Math.max(15, responseTimeSeconds);
    }

    const speakingTimeLimitSeconds = this.readSecondsLike(promptPayload.speakingTimeLimitSeconds);
    if (speakingTimeLimitSeconds !== null) {
      return Math.max(15, speakingTimeLimitSeconds);
    }

    return null;
  }

  private detectWritingLengthProfileFromItemContext(itemContext: string): "integrated_200" | "independent_300" | null {
    const context = this.safeParseObject(itemContext);
    if (!context) {
      return null;
    }

    const promptPayload = this.asObject(context.promptPayload) || {};
    const metadata = this.asObject(context.metadataJson) || {};
    const candidates = [
      this.readString(context.taskType),
      this.readString(metadata.taskType),
      this.readString(metadata.writingType),
      this.readString(metadata.subtype),
      this.readString(metadata.promptType),
      this.readString(metadata.sourceType),
      this.readString(promptPayload.taskType),
      this.readString(promptPayload.writingType),
      this.readString(promptPayload.subtype),
      this.readString(promptPayload.promptType),
      this.readString(promptPayload.sourceType),
      this.readString(promptPayload.mode),
    ]
      .map((value) => value.toLowerCase())
      .filter((value) => value.length > 0);

    const looksIntegrated = candidates.some(
      (value) =>
        value.includes("integrated") ||
        value.includes("summary") ||
        value.includes("summarize") ||
        value.includes("lecture") ||
        value.includes("reading_listening") ||
        value.includes("reading-listening"),
    );
    if (looksIntegrated) {
      return "integrated_200";
    }

    const looksIndependent = candidates.some(
      (value) =>
        value.includes("independent") ||
        value.includes("discussion") ||
        value.includes("opinion") ||
        value.includes("argument") ||
        value.includes("agree_disagree") ||
        value.includes("agree-disagree"),
    );
    if (looksIndependent) {
      return "independent_300";
    }

    return null;
  }

  private exampleWordRange(
    task: ConstructedTaskInput,
    level: "B2" | "C1",
  ): {
    minimumWords: number;
    maximumWords: number;
    targetWords: number;
    speakingSeconds: number | null;
    writingLengthProfile: "integrated_200" | "independent_300" | null;
  } {
    if (task.sectionType === "SPEAKING") {
      const speakingSeconds = Math.max(60, this.extractSpeakingSecondsFromItemContext(task.itemContext) || 60);
      const wordsPerMinute = level === "B2" ? 115 : 135;
      const targetWords = Math.round((speakingSeconds / 60) * wordsPerMinute);

      return {
        minimumWords: Math.max(95, targetWords - 20),
        maximumWords: targetWords + 25,
        targetWords,
        speakingSeconds,
        writingLengthProfile: null,
      };
    }

    const profileFromContext = this.detectWritingLengthProfileFromItemContext(task.itemContext);
    const promptIntent = this.detectPromptIntent(task.prompt);
    const writingLengthProfile =
      profileFromContext || (promptIntent === "integrated_summary" ? "integrated_200" : "independent_300");

    if (writingLengthProfile === "integrated_200") {
      if (level === "B2") {
        return {
          minimumWords: 170,
          maximumWords: 220,
          targetWords: 200,
          speakingSeconds: null,
          writingLengthProfile: "integrated_200",
        };
      }

      return {
        minimumWords: 200,
        maximumWords: 260,
        targetWords: 230,
        speakingSeconds: null,
        writingLengthProfile: "integrated_200",
      };
    }

    if (level === "B2") {
      return {
        minimumWords: 240,
        maximumWords: 300,
        targetWords: 270,
        speakingSeconds: null,
        writingLengthProfile: "independent_300",
      };
    }

    return {
      minimumWords: 270,
      maximumWords: 340,
      targetWords: 300,
      speakingSeconds: null,
      writingLengthProfile: "independent_300",
    };
  }

  private async generateSectionExampleForTask(args: {
    task: ConstructedTaskInput;
    level: "B2" | "C1";
    activeConfig: ActiveProviderConfig;
    avoidExamples: string[];
  }): Promise<string> {
    const endpoint = `${this.normalizeTextProviderBaseUrl(args.activeConfig.baseUrl)}/responses`;
    const model = args.activeConfig.model || "gpt-4.1-mini";
    const reasoningEffort = this.reasoningEffortForModel(model, "minimal");
    const { minimumWords, maximumWords, targetWords, speakingSeconds, writingLengthProfile } = this.exampleWordRange(
      args.task,
      args.level,
    );
    const promptIntent = this.detectPromptIntent(args.task.prompt);

    const sectionDirective =
      args.task.sectionType === "SPEAKING"
        ? `Write as a natural TOEFL speaking script that fits about one minute (${speakingSeconds || 60} seconds) with a clear opening, development, and concise close.`
        : writingLengthProfile === "integrated_200"
          ? "Write as a TOEFL integrated-style response in exactly 3 coherent paragraphs."
          : "Write as a TOEFL independent/discussion response in 4 coherent paragraphs.";
    const vocabularyDirective =
      args.level === "B2"
        ? "Use B2-friendly vocabulary: clear academic words, moderate complexity, mostly straightforward clauses, and reliable grammar."
        : "Use C1-level vocabulary: precise collocations, varied syntax, stronger lexical range, and advanced but natural register.";
    const opinionDirective = this.promptRequestsOpinion(args.task.prompt)
      ? "State a clear personal position and justify it with specific reasons."
      : "Focus on accurately addressing the task requirements without meta commentary.";

    const userPromptLines = [
      "Generate exactly one example response text.",
      "Output plain text only. No JSON. No markdown. No title.",
      `Section type: ${args.task.sectionType}.`,
      `Target level: ${args.level}.`,
      `Prompt intent: ${promptIntent}.`,
      `Word count range: ${minimumWords}-${maximumWords}. Target around ${targetWords} words.`,
      args.task.sectionType === "SPEAKING"
        ? "Speaking length requirement: treat this as a one-minute spoken response."
        : writingLengthProfile === "integrated_200"
          ? "Writing length requirement: integrated-style output around 200 words with exactly 3 paragraphs."
          : "Writing length requirement: independent/discussion output around 300 words with 4 paragraphs.",
      sectionDirective,
      vocabularyDirective,
      opinionDirective,
      "The example must directly answer the prompt and use the full item context.",
      "Never write instructions about how to answer. Never mention 'prompt', 'task', or 'response' in a meta way.",
      `Test item ID: ${args.task.testItemId}`,
      `Prompt: ${args.task.prompt}`,
      `User response (for context only, do not copy): ${args.task.userResponse || "(empty)"}`,
      `Full item context JSON: ${args.task.itemContext}`,
    ];

    if (args.avoidExamples.length > 0) {
      userPromptLines.push(`Must be clearly different from these prior examples: ${JSON.stringify(args.avoidExamples)}`);
    }

    const requestStartedAt = Date.now();
    this.logger.log(
      `[OpenAI Request] report_example_generation endpoint=${endpoint} model=${model} testItemId=${args.task.testItemId} level=${args.level}`,
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.activeConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: "You are a strict TOEFL example generator. Follow all constraints exactly.",
          },
          {
            role: "user",
            content: userPromptLines.join("\n\n"),
          },
        ],
        reasoning: {
          effort: reasoningEffort,
        },
        text: {
          format: {
            type: "text",
          },
        },
      }),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown network error";
      this.logger.warn(
        `[OpenAI Request] report_example_generation network_error endpoint=${endpoint} testItemId=${args.task.testItemId} level=${args.level} message=${message}`,
      );
      throw new Error(`Example generation request failed for ${args.task.testItemId} (${args.level}): ${message}`);
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.logger.warn(
        `[OpenAI Response] report_example_generation status=${response.status} duration_ms=${Date.now() - requestStartedAt} testItemId=${args.task.testItemId} level=${args.level}`,
      );
      throw new Error(
        `Example generation failed for ${args.task.testItemId} (${args.level}) with status ${response.status}: ${body.slice(0, 400) || "empty response body"}`,
      );
    }
    this.logger.log(
      `[OpenAI Response] report_example_generation success status=${response.status} duration_ms=${Date.now() - requestStartedAt} testItemId=${args.task.testItemId} level=${args.level}`,
    );

    const payload = (await response.json().catch(() => null)) as unknown;
    const content = this.extractResponsesOutputText(payload);
    const normalized = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    if (!normalized) {
      throw new Error(`Example generation returned empty content for ${args.task.testItemId} (${args.level}).`);
    }

    return normalized;
  }

  private serializeItemContext(payload: Record<string, unknown>): string {
    let serialized = "{}";
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = "{}";
    }

    if (serialized.length <= 7000) {
      return serialized;
    }

    return `${serialized.slice(0, 7000)}...[truncated]`;
  }

  private normalizeExampleKey(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractPromptKeywords(prompt: string): string[] {
    const stopWords = new Set([
      "about",
      "above",
      "after",
      "again",
      "against",
      "because",
      "before",
      "between",
      "could",
      "should",
      "would",
      "their",
      "there",
      "these",
      "those",
      "where",
      "which",
      "while",
      "whose",
      "people",
      "person",
      "believe",
      "argue",
      "argues",
      "claim",
      "claims",
      "issue",
      "issues",
      "topic",
      "topics",
      "perspective",
      "perspectives",
      "view",
      "views",
      "side",
      "sides",
      "discuss",
      "discussing",
      "explain",
      "provide",
      "provides",
      "provided",
      "free",
      "universities",
      "support",
      "specific",
      "examples",
      "example",
      "opinion",
      "response",
      "prompt",
      "using",
      "include",
      "relevant",
      "evidence",
      "reasons",
      "reason",
      "answer",
      "answers",
      "question",
      "questions",
      "task",
      "tasks",
      "statement",
      "option",
      "options",
      "student",
      "students",
      "university",
      "course",
      "courses",
      "assignment",
      "assignments",
      "state",
      "whether",
      "think",
      "extent",
      "both",
      "rise",
      "lead",
      "leads",
      "create",
      "creates",
      "increase",
      "increases",
      "increased",
      "benefits",
      "drawbacks",
      "advantage",
      "advantages",
      "disadvantages",
      "whole",
      "society",
      "individuals",
    ]);

    const cleaned = prompt.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const rawWords = cleaned.split(/\s+/).filter((word) => word.length >= 4 && !stopWords.has(word));
    const unique: string[] = [];

    for (const word of rawWords) {
      if (!unique.includes(word)) {
        unique.push(word);
      }
      if (unique.length >= 10) {
        break;
      }
    }

    return unique;
  }

  private computeSectionScores(args: {
    sections: Array<{ id: string; sectionType: SectionType }>;
    objectiveReview: ObjectiveAnswerReview[];
    speakingInsights: ConstructedTaskInsight[];
    writingInsights: ConstructedTaskInsight[];
  }): Array<{ sectionId: string; sectionType: SectionType; score: number }> {
    return args.sections.map((section) => {
      if (section.sectionType === "READING" || section.sectionType === "LISTENING") {
        const rows = args.objectiveReview.filter((entry) => entry.sectionType === section.sectionType);
        if (rows.length === 0) {
          return { sectionId: section.id, sectionType: section.sectionType, score: 1 };
        }
        const correctCount = rows.filter((entry) => entry.isCorrect).length;
        const score = this.roundHalf(Math.max(1, (correctCount / rows.length) * 6));
        return { sectionId: section.id, sectionType: section.sectionType, score };
      }

      if (section.sectionType === "SPEAKING") {
        const bands = args.speakingInsights
          .map((entry) => entry.estimatedBand)
          .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
        const score = bands.length > 0 ? this.roundHalf(bands.reduce((sum, band) => sum + band, 0) / bands.length) : 1;
        return { sectionId: section.id, sectionType: section.sectionType, score };
      }

      const bands = args.writingInsights
        .map((entry) => entry.estimatedBand)
        .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
      const score = bands.length > 0 ? this.roundHalf(bands.reduce((sum, band) => sum + band, 0) / bands.length) : 1;
      return { sectionId: section.id, sectionType: section.sectionType, score };
    });
  }

  private objectiveWeaknessInsight(rows: ObjectiveAnswerReview[]): string {
    if (rows.length === 0) {
      return "Objective answer analysis was not available for reading/listening.";
    }

    const incorrect = rows.filter((row) => !row.isCorrect).length;
    if (incorrect === 0) {
      return "No objective weaknesses detected in reading/listening answer review.";
    }

    return `${incorrect} reading/listening questions were incorrect; review answer explanations and identify recurring trap patterns.`;
  }

  private objectiveImprovementTip(rows: ObjectiveAnswerReview[]): string {
    if (rows.length === 0) {
      return "Continue practicing timed objective tasks with post-question rationale checks.";
    }

    const incorrectRows = rows.filter((row) => !row.isCorrect);
    if (incorrectRows.length === 0) {
      return "Maintain your objective-section accuracy by preserving your elimination strategy.";
    }

    const focusedSection = incorrectRows.filter((row) => row.sectionType === "READING").length >= incorrectRows.length / 2
      ? "reading"
      : "listening";
    return `Prioritize ${focusedSection} correction drills: answer first, then compare your reasoning with the official explanation.`;
  }

  private normalizeBand(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) {
      return null;
    }
    return this.roundHalf(Math.min(6, Math.max(1, value)));
  }

  private resolveCorrectAnswer(source: Record<string, unknown>, options: string[]): string {
    const candidates: unknown[] = [
      source.correctAnswer,
      source.correctOption,
      source.correctChoice,
      source.answer,
      source.answerKey,
      source.correctAnswerIndex,
      source.answerIndex,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        const rounded = Math.round(candidate);
        if (rounded >= 1 && rounded <= options.length) {
          return options[rounded - 1] || "";
        }
        if (rounded >= 0 && rounded < options.length) {
          return options[rounded] || "";
        }
      }

      if (typeof candidate !== "string") {
        continue;
      }

      const normalized = candidate.trim();
      if (!normalized) {
        continue;
      }

      if (options.length === 0) {
        return normalized;
      }

      const exactMatch = options.find((option) => option.trim().toLowerCase() === normalized.toLowerCase());
      if (exactMatch) {
        return exactMatch;
      }

      const optionPrefixMatch = normalized.match(/^([A-Da-d])[).:\-]?/);
      if (optionPrefixMatch) {
        const optionIndex = optionPrefixMatch[1]?.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
        if (typeof optionIndex === "number" && optionIndex >= 0 && optionIndex < options.length) {
          return options[optionIndex] || "";
        }
      }
    }

    return "";
  }

  private roundHalf(value: number): number {
    return Math.round(value * 2) / 2;
  }

  private normalizeChoice(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private uniqueNonEmpty(values: string[]): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(normalized);
    }
    return deduped;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private countWords(value: string): number {
    const normalized = value.trim();
    if (!normalized) {
      return 0;
    }
    return normalized.split(/\s+/).length;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private readObjectArray(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => this.asObject(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }

  private parseObjectFromText(content: string): Record<string, unknown> | null {
    const cleaned = content
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    const direct = this.safeParseObject(cleaned);
    if (direct) {
      return direct;
    }

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    return this.safeParseObject(match[0]);
  }

  private extractResponsesOutputText(payload: unknown): string {
    const root = this.asObject(payload);
    if (!root) {
      return "";
    }

    const topLevelText = this.readString(root.output_text);
    if (topLevelText) {
      return topLevelText;
    }

    const outputItems = this.readObjectArray(root.output);
    const textParts: string[] = [];

    for (const outputItem of outputItems) {
      const contentItems = this.readObjectArray(outputItem.content);
      for (const contentItem of contentItems) {
        if (this.readString(contentItem.type) !== "output_text") {
          continue;
        }
        const part = this.readString(contentItem.text);
        if (part) {
          textParts.push(part);
        }
      }
    }

    return textParts.join("\n").trim();
  }

  private normalizeTextProviderBaseUrl(baseUrl: string): string {
    const withoutQuery = baseUrl.trim().split("?")[0].replace(/\/+$/, "");
    return withoutQuery.replace(/\/chat\/completions$/i, "").replace(/\/responses$/i, "");
  }

  private reasoningEffortForModel(model: string, preferred: "minimal" | "medium" | "high"): "minimal" | "medium" | "high" {
    const normalized = model.trim().toLowerCase();
    if (normalized.includes("gpt-5.3-chat")) {
      return "medium";
    }
    return preferred;
  }

  private safeParseObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value);
      return this.asObject(parsed);
    } catch {
      return null;
    }
  }
}
