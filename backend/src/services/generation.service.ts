import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, SectionType, TestItem } from "@prisma/client";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { PrismaService } from "../prisma.service";
import { CryptoService } from "./crypto.service";

type ProviderRequestArgs = {
  baseUrl: string;
  apiKey: string;
  model: string;
  sectionType: SectionType;
  targetOrder: number;
  contextPayload: Prisma.InputJsonObject;
};

type GeneratedTask = {
  taskType: string;
  topic: string;
  promptPayload: Prisma.InputJsonObject;
  audioUrl: string | null;
  questionType: string;
  questionIndex: number;
  questionSetSize: number;
  stimulusType: "passage" | "lecture" | "conversation" | "prompt";
  stimulusGroupId: string;
};

type ListeningStimulusType = "lecture" | "conversation";

type TtsVoiceProfile = {
  voice: string;
  gender: "female" | "male" | "neutral";
  instructions: string;
};

type AudioChunkResult = {
  sequence: number;
  audioUrl: string;
  voice: string;
  gender: "female" | "male" | "neutral";
  instructions: string;
  transcriptChunk: string;
  speakerRole: string;
};

type ResolvedListeningAudio = {
  audioUrl: string | null;
  audioChunks: AudioChunkResult[];
};

const TTS_LEGACY_MODEL_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
]);

const RANDOM_CHUNK_VOICE_PROFILES: TtsVoiceProfile[] = [
  {
    voice: "alloy",
    gender: "neutral",
    instructions: "Use clear diction with balanced pace and controlled intonation.",
  },
  {
    voice: "ash",
    gender: "male",
    instructions: "Use a grounded tone with mild emphasis on key information.",
  },
  {
    voice: "coral",
    gender: "female",
    instructions: "Use bright articulation and engaging conversational rhythm.",
  },
  {
    voice: "echo",
    gender: "male",
    instructions: "Use steady pacing and low-variance pronunciation clarity.",
  },
  {
    voice: "fable",
    gender: "neutral",
    instructions: "Use smooth transitions and moderate emotional range.",
  },
  {
    voice: "nova",
    gender: "female",
    instructions: "Use animated intonation while preserving academic clarity.",
  },
  {
    voice: "onyx",
    gender: "male",
    instructions: "Use confident lower-register delivery with deliberate pauses.",
  },
  {
    voice: "sage",
    gender: "neutral",
    instructions: "Use reflective cadence and careful emphasis on transitions.",
  },
  {
    voice: "shimmer",
    gender: "female",
    instructions: "Use friendly tone and subtle upward inflection in prompts.",
  },
];

const READING_QUESTION_TYPE_BLUEPRINT = [
  "factual_information",
  "negative_factual_information",
  "inference",
  "rhetorical_purpose",
  "vocabulary_in_context",
  "vocabulary_in_context",
  "sentence_simplification",
  "insert_text",
  "detail",
  "prose_summary",
] as const;

const READING_PASSAGE_COUNT = 2;

const LISTENING_QUESTION_TYPE_BLUEPRINT: Array<{ stimulusType: "lecture" | "conversation"; questionType: string }> = [
  { stimulusType: "lecture", questionType: "gist_content" },
  { stimulusType: "lecture", questionType: "detail" },
  { stimulusType: "lecture", questionType: "detail" },
  { stimulusType: "lecture", questionType: "organization" },
  { stimulusType: "lecture", questionType: "attitude" },
  { stimulusType: "lecture", questionType: "connecting_content" },
  { stimulusType: "conversation", questionType: "gist_purpose" },
  { stimulusType: "conversation", questionType: "detail" },
  { stimulusType: "conversation", questionType: "function" },
  { stimulusType: "conversation", questionType: "inference" },
  { stimulusType: "conversation", questionType: "attitude" },
];

const LISTENING_LECTURE_QUESTION_TYPES = LISTENING_QUESTION_TYPE_BLUEPRINT
  .filter((entry) => entry.stimulusType === "lecture")
  .map((entry) => entry.questionType);

const LISTENING_CONVERSATION_QUESTION_TYPES = LISTENING_QUESTION_TYPE_BLUEPRINT
  .filter((entry) => entry.stimulusType === "conversation")
  .map((entry) => entry.questionType);

@Injectable()
export class GenerationService {
  private readonly logger = new Logger(GenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cryptoService: CryptoService,
  ) {}

  async nextTask(sessionId: string, sectionInstanceId: string) {
    const section = await this.prisma.sectionInstance.findUnique({ where: { id: sectionInstanceId } });
    if (!section || section.sessionId !== sessionId) {
      throw new NotFoundException("Section not found for session");
    }

    const existingItems = await this.prisma.testItem.findMany({
      where: { sectionInstanceId },
      orderBy: { createdAt: "asc" },
    });

    const sortedItems = this.sortItemsForDelivery(existingItems);

    const priorAnswers = await this.prisma.answer.findMany({
      where: { testItem: { sectionInstanceId } },
      orderBy: { submittedAt: "asc" },
      select: { testItemId: true, responsePayload: true },
    });

    const answeredItemIds = new Set(
      priorAnswers.map((answer: { testItemId: string; responsePayload: Prisma.JsonValue }) => answer.testItemId),
    );
    const pendingItem = sortedItems.find((item) => !answeredItemIds.has(item.id));
    if (pendingItem) {
      return pendingItem;
    }

    const targetOrder = existingItems.length + 1;
    const sectionGeneratedTopics = sortedItems
      .map((item: { metadataJson: Prisma.JsonValue }) => this.extractTopic(item.metadataJson))
      .filter((topic: string, index: number, all: string[]) => topic !== "unknown" && all.indexOf(topic) === index);

    const recentGeneratedItems = await this.prisma.testItem.findMany({
      where: {
        sectionInstance: {
          sectionType: section.sectionType,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { metadataJson: true },
    });

    const historicalTopics = recentGeneratedItems
      .map((entry: { metadataJson: Prisma.JsonValue }) => this.extractTopic(entry.metadataJson))
      .filter((topic: string, index: number, all: string[]) => topic !== "unknown" && all.indexOf(topic) === index);

    const avoidTopics = [...new Set([...sectionGeneratedTopics, ...historicalTopics])];

    const contextPayload: Prisma.InputJsonObject = {
      sectionType: section.sectionType,
      targetOrder,
      priorGeneratedItems: sortedItems.map((item: { taskType: string; metadataJson: Prisma.JsonValue }) => ({
        taskType: item.taskType,
        topic: this.extractTopic(item.metadataJson),
      })) as Prisma.InputJsonValue,
      priorResponses: priorAnswers.map((answer: { testItemId: string; responsePayload: Prisma.JsonValue }) => ({
        testItemId: answer.testItemId,
        response: answer.responsePayload as Prisma.InputJsonValue,
      })) as Prisma.InputJsonValue,
      antiRepetition: {
        avoidTopics,
      } as Prisma.InputJsonValue,
    };

    const activeProvider = await this.prisma.providerConfig.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: "desc" },
    });

    if (!activeProvider) {
      throw new BadRequestException("No active provider config. Save your provider settings first.");
    }

    const apiKey = this.cryptoService.decrypt(activeProvider.apiKeyEncrypted);

    await this.prisma.generationContextSnapshot.create({
      data: {
        sessionId,
        sectionId: section.id,
        targetItemOrder: targetOrder,
        contextJson: contextPayload,
      },
    });

    const requestArgs: ProviderRequestArgs = {
      baseUrl: activeProvider.baseUrl,
      apiKey,
      model: activeProvider.model,
      sectionType: section.sectionType,
      targetOrder,
      contextPayload,
    };

    const generatedTasks =
      section.sectionType === "READING"
        ? await this.requestReadingQuestionSetFromProvider(requestArgs)
        : section.sectionType === "LISTENING"
          ? await this.requestListeningQuestionSetFromProvider(requestArgs)
          : [await this.requestTaskFromProvider(requestArgs)];

    if (generatedTasks.length === 0) {
      throw new BadRequestException("Task generation returned an empty set.");
    }

    const createdItems: TestItem[] = [];
    for (const generated of generatedTasks) {
      const created = await this.prisma.testItem.create({
        data: {
          sectionInstanceId,
          taskType: generated.taskType,
          promptPayload: generated.promptPayload,
          audioUrl: generated.audioUrl,
          metadataJson: {
            topic: generated.topic,
            questionType: generated.questionType,
            questionIndex: generated.questionIndex,
            questionSetSize: generated.questionSetSize,
            stimulusType: generated.stimulusType,
            stimulusGroupId: generated.stimulusGroupId,
            generatedAt: new Date().toISOString(),
            providerBaseUrl: activeProvider.baseUrl,
            providerModel: activeProvider.model,
          },
        },
      });
      createdItems.push(created);
    }

    const firstItem = createdItems[0];
    if (!firstItem) {
      throw new BadRequestException("Task generation returned an empty set.");
    }

    await this.prisma.sessionEvent.create({
      data: {
        sessionId,
        eventType: "task_generated",
        payload: {
          sectionInstanceId,
          testItemId: firstItem.id,
          generatedCount: generatedTasks.length,
          contextAware: true,
          providerModel: activeProvider.model,
        },
      },
    });

    return firstItem;
  }

  private async requestTaskFromProvider(args: ProviderRequestArgs): Promise<GeneratedTask> {
    const sectionGuidance = this.sectionGuidance(args.sectionType);
    const systemPrompt =
      "You generate TOEFL-like tasks in strict JSON. Return ONLY JSON (no markdown) with keys: taskType, topic, promptPayload, audioUrl(optional). promptPayload must include sectionType, instruction, contextAware, inputType, and section-specific fields.";
    const baseUserPrompt = [
      `Section: ${args.sectionType}`,
      `Target item order: ${args.targetOrder}`,
      `Generation context: ${JSON.stringify(args.contextPayload)}`,
      sectionGuidance,
      "For READING and LISTENING use inputType='choice' with exactly 4 plausible options, one best correctAnswer, and answerExplanation.",
      "For SPEAKING and WRITING use inputType='text'.",
      "For SPEAKING, promptPayload MUST include speakingPrompt, preparationTimeSeconds, and responseTimeSeconds.",
      "For SPEAKING, speakingPrompt must be clear TOEFL-style language (max 2 sentences) with one explicit question and one direct response instruction.",
      "For SPEAKING, do not stack 3+ actions in one prompt (avoid 'summarize + describe + evaluate' chains).",
      "For SPEAKING, avoid vague role-play starts such as 'Imagine a student is meeting...' unless the task objective is very specific.",
      "For WRITING, promptPayload MUST include writingPrompt.",
      "Never leave section-specific prompt fields empty.",
      "If you can synthesize audio, include an absolute audioUrl field. If not, set audioUrl to null.",
      "All textual content must be generated fresh in this run. Do not use pre-written templates or canned blocks.",
    ].join("\n\n");

    const maxAttempts = 3;
    let correction = "";
    let lastIssue = "unknown payload issue";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const userPrompt = correction ? `${baseUserPrompt}\n\n${correction}` : baseUserPrompt;
      const parsed = await this.requestStructuredPayload({
        args,
        systemPrompt,
        userPrompt,
        requestLabel: `${args.sectionType} task generation`,
      });

      try {
        const taskType = this.readString(parsed.taskType) || this.pickTaskType(args.sectionType);
        const topic = this.readString(parsed.topic) || `topic_${args.targetOrder}`;
        const rawPayload = this.asObject(parsed.promptPayload) || parsed;
        const audioUrl = this.readString(parsed.audioUrl) || this.readString(rawPayload.audioUrl);
        const promptPayload = this.composePromptPayload(args.sectionType, args.targetOrder, topic, rawPayload);

        const resolvedAudioUrl =
          args.sectionType === "LISTENING"
            ? await this.resolveListeningAudioUrl({
                baseUrl: args.baseUrl,
                apiKey: args.apiKey,
                transcript: this.readString(promptPayload.transcript),
                providedAudioUrl: audioUrl || null,
              })
            : null;

        return {
          taskType,
          topic,
          promptPayload,
          audioUrl: resolvedAudioUrl,
          questionType: "single_response",
          questionIndex: 1,
          questionSetSize: 1,
          stimulusType: "prompt",
          stimulusGroupId: randomUUID(),
        };
      } catch (error) {
        lastIssue = error instanceof Error ? error.message : "unknown payload issue";
        if (attempt >= maxAttempts) {
          break;
        }
        correction =
          `Previous output was invalid: ${lastIssue}. Regenerate the full JSON from scratch and satisfy every constraint exactly.`;
      }
    }

    throw new BadRequestException(
      `Unable to generate valid ${args.sectionType} task after ${maxAttempts} attempts: ${lastIssue}`,
    );
  }

  private async requestReadingQuestionSetFromProvider(args: ProviderRequestArgs): Promise<GeneratedTask[]> {
    const questionsPerPassage = READING_QUESTION_TYPE_BLUEPRINT.length;
    const expectedQuestionCount = questionsPerPassage * READING_PASSAGE_COUNT;
    const normalizedOrder = Math.max(1, args.targetOrder);
    const passageIndex = Math.floor((normalizedOrder - 1) / questionsPerPassage) + 1;
    if (passageIndex > READING_PASSAGE_COUNT) {
      throw new BadRequestException("READING generation is complete for this section instance.");
    }
    const questionStartIndex = (passageIndex - 1) * questionsPerPassage + 1;
    const requiredQuestionTypeOrder = READING_QUESTION_TYPE_BLUEPRINT.map(
      (questionType, index) => `Q${questionStartIndex + index}: ${questionType}`,
    );

    const systemPrompt =
      "Return strict JSON (no markdown) with keys: taskType, topic, instruction, passage, questions. questions must be an array of exactly 10 objects. Each question object must include questionType, question, options (4 choices), correctAnswer, explanation.";
    const baseUserPrompt = [
      "Generate one TOEFL 2026-style READING passage block.",
      `Section: ${args.sectionType}`,
      `Target passage index: ${passageIndex}/${READING_PASSAGE_COUNT}`,
      `Target item order: ${normalizedOrder}`,
      `Generation context: ${JSON.stringify(args.contextPayload)}`,
      "Generate exactly one academic passage and exactly 10 questions for that same passage.",
      "Passage constraints: target around 800 words (recommended range 800-900), university-level expository tone, B2-C1 academic vocabulary with context clues.",
      "Hard generation target: passage must be at least 800 words. Verify word count before final output.",
      "Use 4-6 coherent academic paragraphs (no bullet lists).",
      "Topic domains: biology, earth science, anthropology, archaeology, astronomy, art history, economics.",
      `Required question type order: ${requiredQuestionTypeOrder.join(" | ")}.`,
      "Each question must have exactly 4 plausible options, one correctAnswer that exactly matches one option, and a short explanation.",
      "All textual content must be generated fresh from this request. Do not use templates or canned text.",
    ].join("\n\n");

    const maxAttempts = 5;
    let correction = "";
    let lastIssue = "unknown payload issue";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const userPrompt = correction ? `${baseUserPrompt}\n\n${correction}` : baseUserPrompt;
      const parsed = await this.requestStructuredPayload({
        args,
        systemPrompt,
        userPrompt,
        requestLabel: "READING passage block generation",
      });

      try {
        const topic = this.readString(parsed.topic) || `reading_topic_passage_${passageIndex}`;
        const taskType = this.readString(parsed.taskType) || "read_an_academic_passage";
        const instruction = this.requireNonEmptyText(this.readString(parsed.instruction), "READING instruction");
        const passage = this.ensureMinimumWords(this.readString(parsed.passage), 620, `READING passage ${passageIndex}`);
        const questionObjects = this.readObjectArray(parsed.questions);
        if (questionObjects.length < questionsPerPassage) {
          throw new BadRequestException(
            `READING passage ${passageIndex} requires ${questionsPerPassage} questions but received ${questionObjects.length}.`,
          );
        }

        const stimulusGroupId = randomUUID();
        const passageWordCount = this.countWords(passage);
        const tasks: GeneratedTask[] = [];

        for (let index = 0; index < questionsPerPassage; index += 1) {
          const absoluteQuestionIndex = questionStartIndex + index;
          const questionType = READING_QUESTION_TYPE_BLUEPRINT[index] || "detail";
          const questionObject = questionObjects[index] || {};
          const question = this.requireNonEmptyText(
            this.readString(questionObject.question),
            `READING question ${absoluteQuestionIndex}`,
          );
          const options = this.normalizeOptions(this.readStringArray(questionObject.options));
          const correctAnswer = this.resolveCorrectAnswer(questionObject, options);
          const answerExplanation = this.resolveAnswerExplanation(questionObject, correctAnswer);

          tasks.push({
            taskType,
            topic,
            audioUrl: null,
            questionType,
            questionIndex: absoluteQuestionIndex,
            questionSetSize: expectedQuestionCount,
            stimulusType: "passage",
            stimulusGroupId,
            promptPayload: {
              sectionType: "READING",
              contextAware: true,
              inputType: "choice",
              instruction,
              passage,
              question,
              options,
              correctAnswer,
              answerExplanation,
              passageIndex,
              passageSetSize: READING_PASSAGE_COUNT,
              wordCount: passageWordCount,
              topic,
              questionType,
              questionIndex: absoluteQuestionIndex,
              questionSetSize: expectedQuestionCount,
              stimulusType: "passage",
            },
          });
        }

        return tasks;
      } catch (error) {
        lastIssue = error instanceof Error ? error.message : "unknown payload issue";
        if (attempt >= maxAttempts) {
          break;
        }
        correction =
          `Previous output was invalid: ${lastIssue}. Regenerate ONE READING passage block from scratch with one passage and 10 fully valid questions.`;
      }
    }

    throw new BadRequestException(
      `Unable to generate valid READING passage block after ${maxAttempts} attempts: ${lastIssue}`,
    );
  }

  private async requestListeningQuestionSetFromProvider(args: ProviderRequestArgs): Promise<GeneratedTask[]> {
    const normalizedOrder = Math.max(1, args.targetOrder);
    const lectureQuestionCount = LISTENING_LECTURE_QUESTION_TYPES.length;
    const expectedQuestionCount = LISTENING_QUESTION_TYPE_BLUEPRINT.length;
    if (normalizedOrder > expectedQuestionCount) {
      throw new BadRequestException("LISTENING generation is complete for this section instance.");
    }

    const stimulusType: ListeningStimulusType = normalizedOrder <= lectureQuestionCount ? "lecture" : "conversation";
    const questionTypeBlock =
      stimulusType === "lecture" ? LISTENING_LECTURE_QUESTION_TYPES : LISTENING_CONVERSATION_QUESTION_TYPES;
    const questionStartIndex = stimulusType === "lecture" ? 1 : lectureQuestionCount + 1;
    const minimumTranscriptWords = stimulusType === "lecture" ? 420 : 320;
    const requiredQuestionTypeOrder = questionTypeBlock.map(
      (questionType, index) => `Q${questionStartIndex + index}: ${questionType}`,
    );

    const systemPrompt =
      "Return strict JSON (no markdown) with keys: taskType, topic, instruction, stimulusType, transcript, questions, audioUrl(optional). questions must be an array with one object per required question and each object must include questionType, question, options (4 choices), correctAnswer, explanation.";
    const baseUserPrompt = [
      "Generate one TOEFL 2026-style LISTENING stimulus block.",
      `Section: ${args.sectionType}`,
      `Target item order: ${normalizedOrder}`,
      `Target stimulus type: ${stimulusType}`,
      `Generation context: ${JSON.stringify(args.contextPayload)}`,
      stimulusType === "lecture"
        ? "Lecture transcript constraints: 420-760 words, academic talk style with discourse markers and implied meaning."
        : "Conversation transcript constraints: 320-520 words, realistic campus interaction with explicit speaker labels (for example: Student:, Advisor:, Professor:).",
      "Transcript must be pure spoken content only. Do not append recap paragraphs, meta summaries, or outro lines.",
      "Forbidden tail patterns include: 'The lecture continues with a concrete example...', 'A follow-up detail introduces...', 'The discussion compares two plausible interpretations...', 'An additional campus detail shows...'.",
      `Generate exactly one transcript and exactly ${questionTypeBlock.length} questions for that same transcript.`,
      `Required question type order: ${requiredQuestionTypeOrder.join(" | ")}.`,
      "Each question must have exactly 4 options, one correctAnswer that matches one option, and a concise explanation.",
      "All textual content must be generated fresh from this request. Do not use templates or canned text.",
    ].join("\n\n");

    const maxAttempts = 4;
    let correction = "";
    let lastIssue = "unknown payload issue";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const userPrompt = correction ? `${baseUserPrompt}\n\n${correction}` : baseUserPrompt;
      const parsed = await this.requestStructuredPayload({
        args,
        systemPrompt,
        userPrompt,
        requestLabel: `LISTENING ${stimulusType} block generation`,
      });

      try {
        const topic = this.readString(parsed.topic) || `listening_topic_${questionStartIndex}`;
        const taskType =
          this.readString(parsed.taskType) ||
          (stimulusType === "lecture" ? "listen_to_an_academic_talk" : "listen_to_a_conversation");
        const instruction = this.requireNonEmptyText(this.readString(parsed.instruction), "LISTENING instruction");
        const transcript = this.ensureMinimumWords(
          this.readString(parsed.transcript),
          minimumTranscriptWords,
          `LISTENING ${stimulusType} transcript`,
        );
        if (stimulusType === "conversation") {
          const hasSpeakerLabels = /[A-Za-z][A-Za-z ]{1,24}:\s*/.test(transcript);
          if (!hasSpeakerLabels) {
            throw new BadRequestException("LISTENING conversation transcript must include explicit speaker labels.");
          }
        }

        const questionObjects = this.readObjectArray(parsed.questions);
        if (questionObjects.length < questionTypeBlock.length) {
          throw new BadRequestException(
            `LISTENING ${stimulusType} block requires ${questionTypeBlock.length} questions but received ${questionObjects.length}.`,
          );
        }

        const providedAudioUrl = this.readString(parsed.audioUrl) || null;
        const audioAssets = await this.resolveListeningAudioAssets({
          baseUrl: args.baseUrl,
          apiKey: args.apiKey,
          transcript,
          providedAudioUrl,
          stimulusType,
        });

        const wordCount = this.countWords(transcript);
        const estimatedDurationSeconds = Math.max(stimulusType === "lecture" ? 180 : 150, Math.round((wordCount / 145) * 60));
        const stimulusGroupId = randomUUID();
        const tasks: GeneratedTask[] = [];

        for (let index = 0; index < questionTypeBlock.length; index += 1) {
          const absoluteQuestionIndex = questionStartIndex + index;
          const questionType = questionTypeBlock[index] || "detail";
          const questionObject = questionObjects[index] || {};
          const question = this.requireNonEmptyText(
            this.readString(questionObject.question),
            `LISTENING question ${absoluteQuestionIndex}`,
          );
          const options = this.normalizeOptions(this.readStringArray(questionObject.options));
          const correctAnswer = this.resolveCorrectAnswer(questionObject, options);
          const answerExplanation = this.resolveAnswerExplanation(questionObject, correctAnswer);

          tasks.push({
            taskType,
            topic,
            audioUrl: audioAssets.audioUrl,
            questionType,
            questionIndex: absoluteQuestionIndex,
            questionSetSize: expectedQuestionCount,
            stimulusType,
            stimulusGroupId,
            promptPayload: {
              sectionType: "LISTENING",
              contextAware: true,
              inputType: "choice",
              instruction,
              transcript,
              question,
              options,
              correctAnswer,
              answerExplanation,
              estimatedDurationSeconds,
              wordCount,
              topic,
              questionType,
              questionIndex: absoluteQuestionIndex,
              questionSetSize: expectedQuestionCount,
              stimulusType,
              stimulusGroupId,
              audioChunks: audioAssets.audioChunks as Prisma.InputJsonValue,
            },
          });
        }

        return tasks;
      } catch (error) {
        lastIssue = error instanceof Error ? error.message : "unknown payload issue";
        if (attempt >= maxAttempts) {
          break;
        }
        correction =
          `Previous output was invalid: ${lastIssue}. Regenerate ONE LISTENING ${stimulusType} block from scratch with transcript + ${questionTypeBlock.length} fully valid questions.`;
      }
    }

    throw new BadRequestException(
      `Unable to generate valid LISTENING ${stimulusType} block after ${maxAttempts} attempts: ${lastIssue}`,
    );
  }

  private async requestStructuredPayload(input: {
    args: ProviderRequestArgs;
    systemPrompt: string;
    userPrompt: string;
    requestLabel?: string;
  }): Promise<Record<string, unknown>> {
    const endpoint = `${this.normalizeTextProviderBaseUrl(input.args.baseUrl)}/responses`;
    const reasoningEffort = this.reasoningEffortForModel(input.args.model, "minimal");
    const maxAttempts = 4;
    let promptWithCorrection = input.userPrompt;
    let lastIssue = "unknown provider failure";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      const requestStartedAt = Date.now();
      const requestLabel = input.requestLabel || "structured generation";
      this.logger.log(
        `[OpenAI Request] ${requestLabel} attempt=${attempt}/${maxAttempts} endpoint=${endpoint} model=${input.args.model}`,
      );
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.args.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: input.args.model,
            input: [
              {
                role: "system",
                content: input.systemPrompt,
              },
              {
                role: "user",
                content: promptWithCorrection,
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
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "unknown network error";
        lastIssue = `network error: ${message}`;
        this.logger.warn(
          `[OpenAI Request] ${requestLabel} attempt=${attempt}/${maxAttempts} network_error duration_ms=${Date.now() - requestStartedAt} message=${message}`,
        );
        if (attempt < maxAttempts) {
          promptWithCorrection = `${input.userPrompt}\n\nPrevious output was invalid: ${lastIssue}. Regenerate from scratch and return ONLY strict JSON.`;
          await this.waitMs(200 * attempt);
          continue;
        }
        break;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Provider request failed.");
        lastIssue = `status ${response.status}: ${errorBody.slice(0, 220) || "empty response body"}`;
        this.logger.warn(
          `[OpenAI Response] ${requestLabel} attempt=${attempt}/${maxAttempts} status=${response.status} duration_ms=${Date.now() - requestStartedAt}`,
        );
      } else {
        const completion = (await response.json().catch(() => null)) as unknown;
        const content = this.extractResponsesOutputText(completion);
        if (!content) {
          lastIssue = "response missing output text";
          this.logger.warn(
            `[OpenAI Response] ${requestLabel} attempt=${attempt}/${maxAttempts} missing_content status=${response.status} duration_ms=${Date.now() - requestStartedAt}`,
          );
        } else {
          const parsed = this.parseObjectFromText(content);
          if (parsed) {
            this.logger.log(
              `[OpenAI Response] ${requestLabel} attempt=${attempt}/${maxAttempts} success status=${response.status} duration_ms=${Date.now() - requestStartedAt}`,
            );
            return parsed;
          }
          lastIssue = "response was not valid JSON";
          this.logger.warn(
            `[OpenAI Response] ${requestLabel} attempt=${attempt}/${maxAttempts} invalid_json status=${response.status} duration_ms=${Date.now() - requestStartedAt}`,
          );
        }
      }

      if (attempt < maxAttempts) {
        promptWithCorrection = `${input.userPrompt}\n\nPrevious output was invalid: ${lastIssue}. Regenerate from scratch, obey all hard constraints exactly, and return ONLY strict JSON.`;
        await this.waitMs(200 * attempt);
      }
    }

    const label = input.requestLabel || "structured generation";
    throw new BadRequestException(`Unable to complete ${label} after ${maxAttempts} attempts: ${lastIssue}`);
  }

  private async resolveListeningAudioAssets(args: {
    baseUrl: string;
    apiKey: string;
    transcript: string;
    providedAudioUrl: string | null;
    stimulusType: ListeningStimulusType;
  }): Promise<ResolvedListeningAudio> {
    if (!args.transcript.trim()) {
      return {
        audioUrl: args.providedAudioUrl,
        audioChunks: [],
      };
    }

    const ttsModel = (process.env.TTS_MODEL || "gpt-4o-mini-tts").trim();
    const preferredLectureVoiceProfile =
      args.stimulusType === "lecture" ? this.preferredVoiceProfileForStimulus(ttsModel) : undefined;

    if (preferredLectureVoiceProfile) {
      const fullStimulusInstructions = `${this.toneInstructionForChunk(
        args.stimulusType,
        "lecture_narrator",
      )} ${preferredLectureVoiceProfile.instructions} Keep speech clear for TOEFL listening practice.`;

      const fullStimulusAudioUrl = await this.generateSpeechAudio(args.baseUrl, args.apiKey, args.transcript, {
        voice: preferredLectureVoiceProfile.voice,
        instructions: fullStimulusInstructions,
        filePrefix: `${args.stimulusType}-full`,
      });

      if (fullStimulusAudioUrl) {
        return {
          audioUrl: fullStimulusAudioUrl,
          audioChunks: [
            {
              sequence: 1,
              audioUrl: fullStimulusAudioUrl,
              voice: preferredLectureVoiceProfile.voice,
              gender: preferredLectureVoiceProfile.gender,
              instructions: fullStimulusInstructions,
              transcriptChunk: this.stripSpeakerRolePrefixes(args.transcript),
              speakerRole: "lecture_narrator",
            },
          ],
        };
      }
    }

    const generatedChunks = await this.generateSpeechAudioChunks({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      transcript: args.transcript,
      stimulusType: args.stimulusType,
      fixedVoiceProfile: preferredLectureVoiceProfile,
    });

    if (generatedChunks.length > 0) {
      return {
        audioUrl: generatedChunks[0]?.audioUrl || null,
        audioChunks: generatedChunks,
      };
    }

    if (args.providedAudioUrl) {
      return {
        audioUrl: args.providedAudioUrl,
        audioChunks: [],
      };
    }

    if (args.stimulusType === "conversation") {
      return {
        audioUrl: null,
        audioChunks: [],
      };
    }

    const fallbackAudio = await this.generateSpeechAudio(args.baseUrl, args.apiKey, args.transcript, {
      filePrefix: `${args.stimulusType}-full`,
    });

    return {
      audioUrl: fallbackAudio,
      audioChunks: [],
    };
  }

  private async resolveListeningAudioUrl(args: {
    baseUrl: string;
    apiKey: string;
    transcript: string;
    providedAudioUrl: string | null;
  }): Promise<string | null> {
    if (args.providedAudioUrl) {
      return args.providedAudioUrl;
    }
    if (!args.transcript.trim()) {
      return null;
    }
    return this.generateSpeechAudio(args.baseUrl, args.apiKey, args.transcript, { filePrefix: "listen-full" });
  }

  private async generateSpeechAudioChunks(args: {
    baseUrl: string;
    apiKey: string;
    transcript: string;
    stimulusType: ListeningStimulusType;
    fixedVoiceProfile?: TtsVoiceProfile;
  }): Promise<AudioChunkResult[]> {
    const transcriptChunks = this.chunkTranscriptForTts(args.transcript, args.stimulusType);
    const generated: AudioChunkResult[] = [];
    const roleVoiceAssignments = new Map<string, TtsVoiceProfile>();
    const usedVoices = new Set<string>();
    const ttsModel = (process.env.TTS_MODEL || "gpt-4o-mini-tts").trim();

    for (let index = 0; index < transcriptChunks.length; index += 1) {
      const chunk = transcriptChunks[index];
      if (!chunk || !chunk.text.trim()) {
        continue;
      }

      const cleanedChunkText = this.stripSpeakerRolePrefixes(chunk.text);
      if (!cleanedChunkText) {
        continue;
      }

      const voiceProfile =
        args.fixedVoiceProfile ||
        this.voiceProfileForChunk({
          stimulusType: args.stimulusType,
          speakerRole: chunk.speakerRole,
          usedVoices,
          roleVoiceAssignments,
          ttsModel,
        });
      const chunkInstructions = `${voiceProfile.instructions} Keep speech clear for TOEFL listening practice.`;
      const audioUrl = await this.generateSpeechAudio(args.baseUrl, args.apiKey, cleanedChunkText, {
        voice: voiceProfile.voice,
        instructions: chunkInstructions,
        filePrefix: `${args.stimulusType}-chunk-${index + 1}`,
      });

      if (!audioUrl) {
        continue;
      }

      generated.push({
        sequence: index + 1,
        audioUrl,
        voice: voiceProfile.voice,
        gender: voiceProfile.gender,
        instructions: chunkInstructions,
        transcriptChunk: cleanedChunkText,
        speakerRole: chunk.speakerRole,
      });
    }

    return generated;
  }

  private chunkTranscriptForTts(
    transcript: string,
    stimulusType: ListeningStimulusType,
  ): Array<{ text: string; speakerRole: string }> {
    if (stimulusType === "lecture") {
      const lectureChunks = this.chunkTextBySentenceWordTarget(transcript, 95, 150).map((text) => ({
        text,
        speakerRole: "professor",
      }));
      return this.capChunkCount(lectureChunks, 8);
    }

    const normalized = transcript.replace(/\s+/g, " ").trim();
    const speakerTurns =
      normalized.match(/[A-Za-z][A-Za-z ]{1,24}:[\s\S]*?(?=(?:\s+[A-Za-z][A-Za-z ]{1,24}:)|$)/g) || [];

    if (speakerTurns.length === 0) {
      const fallbackChunks = this.chunkTextBySentenceWordTarget(normalized, 70, 115).map((text) => ({
        text: this.stripSpeakerRolePrefixes(text),
        speakerRole: "default",
      }));
      return this.capChunkCount(fallbackChunks, 7);
    }

    const chunks: Array<{ text: string; speakerRole: string }> = [];

    for (const turnRaw of speakerTurns) {
      const turn = turnRaw.trim();
      if (!turn) {
        continue;
      }

      const parsedTurn = this.parseConversationTurn(turn);
      if (!parsedTurn.text) {
        continue;
      }

      const turnChunks = this.chunkTextBySentenceWordTarget(parsedTurn.text, 52, 92);
      const safeTurnChunks = turnChunks.length > 0 ? turnChunks : [parsedTurn.text];
      for (const turnChunk of safeTurnChunks) {
        const cleanedChunk = this.stripSpeakerRolePrefixes(turnChunk);
        if (!cleanedChunk) {
          continue;
        }
        chunks.push({ text: cleanedChunk, speakerRole: parsedTurn.speakerRole });
      }
    }

    if (chunks.length === 0) {
      const fallbackChunks = this.chunkTextBySentenceWordTarget(normalized, 70, 115).map((text) => ({
        text: this.stripSpeakerRolePrefixes(text),
        speakerRole: "default",
      }));
      return this.capChunkCount(fallbackChunks, 7);
    }

    return this.capChunkCount(chunks, 12);
  }

  private capChunkCount(
    chunks: Array<{ text: string; speakerRole: string }>,
    maxChunks: number,
  ): Array<{ text: string; speakerRole: string }> {
    const filtered = chunks
      .map((chunk) => ({ text: chunk.text.trim(), speakerRole: chunk.speakerRole || "default" }))
      .filter((chunk) => chunk.text.length > 0);

    if (filtered.length <= maxChunks) {
      return filtered;
    }

    const merged = [...filtered];
    while (merged.length > maxChunks) {
      const mergeIndex = merged.findIndex(
        (chunk, index) => index < merged.length - 1 && chunk.speakerRole === merged[index + 1]?.speakerRole,
      );
      if (mergeIndex < 0) {
        break;
      }

      const current = merged[mergeIndex];
      const next = merged[mergeIndex + 1];
      merged.splice(mergeIndex, 2, {
        text: `${current.text} ${next.text}`.trim(),
        speakerRole: current.speakerRole || "default",
      });
    }

    return merged;
  }

  private chunkTextBySentenceWordTarget(text: string, targetWords: number, maxWords: number): string[] {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return [];
    }

    const sentences = this.splitIntoSentences(normalized);
    if (sentences.length === 0) {
      return [normalized];
    }

    const chunks: string[] = [];
    let buffer = "";

    for (const sentence of sentences) {
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (buffer && this.countWords(candidate) > maxWords) {
        chunks.push(buffer.trim());
        buffer = sentence;
      } else {
        buffer = candidate;
      }

      if (this.countWords(buffer) >= targetWords) {
        chunks.push(buffer.trim());
        buffer = "";
      }
    }

    if (buffer.trim()) {
      chunks.push(buffer.trim());
    }

    return chunks;
  }

  private splitIntoSentences(text: string): string[] {
    const matches = text.match(/[^.!?]+[.!?]?/g) || [];
    return matches.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
  }

  private detectConversationRole(labelRaw: string): string {
    const label = labelRaw.trim().toLowerCase();
    if (label.includes("student")) {
      return "student";
    }
    if (label.includes("advisor") || label.includes("counselor") || label.includes("staff")) {
      return "advisor";
    }
    if (label.includes("professor") || label.includes("instructor") || label.includes("lecturer") || label.includes("teacher")) {
      return "professor";
    }
    return "default";
  }

  private parseConversationTurn(turn: string): { text: string; speakerRole: string } {
    const labelMatch = turn.match(/^([A-Za-z ]+):\s*([\s\S]*)$/);
    if (!labelMatch) {
      return {
        text: this.stripSpeakerRolePrefixes(turn),
        speakerRole: "default",
      };
    }

    return {
      text: this.stripSpeakerRolePrefixes(labelMatch[2]),
      speakerRole: this.detectConversationRole(labelMatch[1]),
    };
  }

  private stripSpeakerRolePrefixes(text: string): string {
    return text
      .replace(/(?:^|\s)[A-Za-z][A-Za-z ]{1,24}:\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private voiceProfileForChunk(args: {
    stimulusType: ListeningStimulusType;
    speakerRole: string;
    usedVoices: Set<string>;
    roleVoiceAssignments: Map<string, TtsVoiceProfile>;
    ttsModel: string;
  }): TtsVoiceProfile {
    const normalizedRole =
      args.stimulusType === "lecture" ? "lecture_narrator" : args.speakerRole.trim().toLowerCase() || "default";
    const assigned = args.roleVoiceAssignments.get(normalizedRole);
    if (assigned) {
      return assigned;
    }

    const availableProfiles = this.voiceProfilesForModel(args.ttsModel);
    const conversationProfiles =
      args.stimulusType === "conversation"
        ? availableProfiles.filter((profile) => profile.gender === "female" || profile.gender === "male")
        : availableProfiles;
    const roleAssignableProfiles = conversationProfiles.length > 0 ? conversationProfiles : availableProfiles;

    let candidates = roleAssignableProfiles.filter((profile) => !args.usedVoices.has(profile.voice));
    if (candidates.length === 0) {
      candidates = roleAssignableProfiles;
    }

    const selected = candidates[Math.floor(Math.random() * candidates.length)] || roleAssignableProfiles[0];
    const roleInstruction = this.toneInstructionForChunk(args.stimulusType, normalizedRole);
    const profile: TtsVoiceProfile = {
      voice: selected.voice,
      gender: selected.gender,
      instructions: `${roleInstruction} ${selected.instructions} Speak in standard American English.`,
    };

    args.roleVoiceAssignments.set(normalizedRole, profile);
    args.usedVoices.add(profile.voice);

    return profile;
  }

  private voiceProfilesForModel(ttsModel: string): TtsVoiceProfile[] {
    const normalized = ttsModel.toLowerCase();
    if (normalized === "tts-1" || normalized === "tts-1-hd") {
      const filtered = RANDOM_CHUNK_VOICE_PROFILES.filter((profile) => TTS_LEGACY_MODEL_VOICES.has(profile.voice));
      return filtered.length > 0 ? filtered : RANDOM_CHUNK_VOICE_PROFILES;
    }
    return RANDOM_CHUNK_VOICE_PROFILES;
  }

  private preferredVoiceProfileForStimulus(ttsModel: string): TtsVoiceProfile {
    const availableProfiles = this.voiceProfilesForModel(ttsModel);
    const preferredVoice = (process.env.TTS_VOICE || "coral").trim().toLowerCase();
    const matched = availableProfiles.find((profile) => profile.voice.toLowerCase() === preferredVoice);
    return matched || availableProfiles[0] || RANDOM_CHUNK_VOICE_PROFILES[0];
  }

  private toneInstructionForChunk(stimulusType: ListeningStimulusType, speakerRole: string): string {
    if (stimulusType === "lecture") {
      return "Deliver as one lecturer with consistent academic pacing and clear emphasis on key concepts.";
    }

    const normalizedRole = speakerRole.toLowerCase();
    if (normalizedRole.includes("student")) {
      return "Deliver as a university student with curious, slightly tentative intonation.";
    }
    if (normalizedRole.includes("advisor")) {
      return "Deliver as a campus advisor with calm, supportive, and practical tone.";
    }
    if (normalizedRole.includes("professor")) {
      return "Deliver as an instructor with helpful authority and steady pacing.";
    }

    return "Deliver as a natural campus conversation turn with realistic pauses and intonation.";
  }

  private async generateSpeechAudio(
    baseUrl: string,
    apiKey: string,
    transcript: string,
    options?: {
      voice?: string;
      instructions?: string;
      filePrefix?: string;
    },
  ): Promise<string | null> {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/audio/speech`;
    const ttsModel = process.env.TTS_MODEL || "gpt-4o-mini-tts";
    const voice = options?.voice || process.env.TTS_VOICE || "coral";
    const instructions =
      options?.instructions ||
      process.env.TTS_INSTRUCTIONS ||
      "Speak in a clear academic tone at a natural pace for TOEFL listening practice.";

    try {
      const requestStartedAt = Date.now();
      this.logger.log(
        `[OpenAI Request] tts endpoint=${endpoint} model=${ttsModel} voice=${voice} transcript_chars=${transcript.length}`,
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ttsModel,
          voice,
          input: transcript,
          instructions,
          response_format: "mp3",
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        this.logger.warn(
          `[OpenAI Response] tts status=${response.status} duration_ms=${Date.now() - requestStartedAt} endpoint=${endpoint}`,
        );
        console.warn(`TTS request failed (${response.status}). ${errorBody.slice(0, 220)}`);
        return null;
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      if (audioBuffer.byteLength === 0) {
        return null;
      }

      const audioDirectory = process.env.AUDIO_STORAGE_DIR || join(process.cwd(), "generated-audio");
      await mkdir(audioDirectory, { recursive: true });

      const safePrefix = (options?.filePrefix || "listen").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "listen";
      const fileName = `${safePrefix}-${Date.now()}-${randomUUID()}.mp3`;
      await writeFile(join(audioDirectory, fileName), audioBuffer);
      this.logger.log(
        `[OpenAI Response] tts success status=${response.status} duration_ms=${Date.now() - requestStartedAt} bytes=${audioBuffer.byteLength}`,
      );

      return `${this.publicApiBaseUrl()}/audio/${fileName}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown TTS error";
      this.logger.warn(`[OpenAI Request] tts network_error endpoint=${endpoint} message=${message}`);
      console.warn(`TTS generation failed: ${message}`);
      return null;
    }
  }

  private publicApiBaseUrl(): string {
    const explicit = process.env.PUBLIC_API_BASE_URL?.trim();
    if (explicit) {
      return explicit.replace(/\/+$/, "");
    }
    const port = process.env.GRAPHQL_PORT || "4000";
    return `http://localhost:${port}`;
  }

  private composePromptPayload(
    sectionType: SectionType,
    targetOrder: number,
    topic: string,
    payload: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    const instruction = this.requireNonEmptyText(this.readString(payload.instruction), `${sectionType} instruction`);

    if (sectionType === "READING") {
      const question = this.requireNonEmptyText(this.readString(payload.question), `READING question ${targetOrder}`);
      const options = this.normalizeOptions(this.readStringArray(payload.options));
      const correctAnswer = this.resolveCorrectAnswer(payload, options);
      const answerExplanation = this.resolveAnswerExplanation(payload, correctAnswer);
      const passage = this.ensureMinimumWords(this.readString(payload.passage), 620, "READING passage");

      return {
        sectionType,
        contextAware: true,
        inputType: "choice",
        instruction,
        passage,
        question,
        options,
        correctAnswer,
        answerExplanation,
        wordCount: this.countWords(passage),
        topic,
      };
    }

    if (sectionType === "LISTENING") {
      const question = this.requireNonEmptyText(this.readString(payload.question), `LISTENING question ${targetOrder}`);
      const options = this.normalizeOptions(this.readStringArray(payload.options));
      const correctAnswer = this.resolveCorrectAnswer(payload, options);
      const answerExplanation = this.resolveAnswerExplanation(payload, correctAnswer);
      const transcript = this.ensureMinimumWords(this.readString(payload.transcript), 380, "LISTENING transcript");
      const transcriptWordCount = this.countWords(transcript);

      return {
        sectionType,
        contextAware: true,
        inputType: "choice",
        instruction,
        transcript,
        question,
        options,
        correctAnswer,
        answerExplanation,
        estimatedDurationSeconds: Math.max(150, Math.round((transcriptWordCount / 145) * 60)),
        wordCount: transcriptWordCount,
        topic,
      };
    }

    if (sectionType === "SPEAKING") {
      const preparationTimeSeconds = this.normalizeSeconds(payload.preparationTimeSeconds, 15, 0);
      const responseTimeSeconds = this.normalizeSeconds(payload.responseTimeSeconds, 45, 15);
      const speakingTimeLimitSeconds = this.normalizeSeconds(
        payload.speakingTimeLimitSeconds,
        preparationTimeSeconds + responseTimeSeconds,
        15,
      );
      const speakingPrompt = this.ensureHighQualitySpeakingPrompt(this.readString(payload.speakingPrompt));

      return {
        sectionType,
        contextAware: true,
        inputType: "text",
        instruction,
        speakingPrompt,
        preparationTimeSeconds,
        responseTimeSeconds,
        speakingTimeLimitSeconds,
        targetOrder,
        topic,
      };
    }

    return {
      sectionType,
      contextAware: true,
      inputType: "text",
      instruction,
      writingPrompt: this.requireNonEmptyFormattedText(
        this.readString(payload.writingPrompt),
        "WRITING promptPayload.writingPrompt",
      ),
      targetOrder,
      topic,
    };
  }

  private sectionGuidance(sectionType: SectionType): string {
    if (sectionType === "READING") {
      return [
        "Reading requirements:",
        "- Generate one READING passage block per request: one academic passage plus 10 questions for that same passage.",
        "- Passage target length: around 800 words (recommended range 800-900), TOEFL-style expository tone, B2-C1 academic vocabulary.",
        "- Every question must provide exactly 4 options, one matching correctAnswer, and a concise explanation.",
        "- Use topic domains such as biology, earth science, anthropology, archaeology, astronomy, art history, or economics.",
        "- Keep objective paragraph-based organization (no template/canned text).",
      ].join("\n");
    }

    if (sectionType === "LISTENING") {
      return [
        "Listening requirements:",
        "- Generate one LISTENING stimulus block per request: one transcript plus its full question block.",
        "- Use realistic TOEFL campus conversation or mini-lecture topics.",
        "- Lecture transcript range: 420-760 words. Conversation transcript range: 320-520 words.",
        "- Conversation transcripts must include explicit speaker labels (for example: Student:, Advisor:, Professor:).",
        "- Include discourse markers, speaker intentions, and implied meaning suitable for gist/detail/inference questions.",
        "- Do not append recap/summary/outro text; end naturally after the last content point.",
      ].join("\n");
    }

    if (sectionType === "SPEAKING") {
      return [
        "Speaking requirements:",
        "- Generate a TOEFL-style speaking prompt grounded in campus or academic context.",
        "- Vary task style across: independent opinion, integrated campus/academic response, short interview-style response.",
        "- Prompt must be clear and concise (maximum 2 sentences) with one direct question and one explicit response instruction.",
        "- Do not create overloaded prompts with 3+ directives (for example summarize+describe+evaluate in one item).",
        "- Require a clear claim, supporting detail(s), and concise conclusion.",
        "- Include realistic prep and response timing metadata.",
      ].join("\n");
    }

    return [
      "Writing requirements:",
      "- Generate a TOEFL-style academic writing prompt (integrated or discussion style).",
      "- Prompt must demand clear argumentation, evidence, and organization.",
    ].join("\n");
  }

  private normalizeOptions(options: string[]): string[] {
    const normalized = options.map((option) => option.trim()).filter((option) => option.length > 0);
    if (normalized.length < 4) {
      throw new BadRequestException(`Provider response must include at least 4 options, received ${normalized.length}.`);
    }
    return normalized.slice(0, 4);
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

      const numericCandidate = Number(normalized);
      if (Number.isFinite(numericCandidate)) {
        const rounded = Math.round(numericCandidate);
        if (rounded >= 1 && rounded <= options.length) {
          return options[rounded - 1] || "";
        }
      }
    }

    throw new BadRequestException("Provider response missing a resolvable correctAnswer for the provided options.");
  }

  private resolveAnswerExplanation(source: Record<string, unknown>, correctAnswer: string): string {
    const explanation =
      this.readString(source.answerExplanation) ||
      this.readString(source.explanation) ||
      this.readString(source.rationale) ||
      "";

    if (explanation) {
      return explanation;
    }

    throw new BadRequestException(
      `Provider response missing explanation/rationale for correct answer ${correctAnswer || "(empty)"}.`,
    );
  }

  private ensureHighQualitySpeakingPrompt(candidate: string): string {
    const normalized = candidate.replace(/\s+/g, " ").trim();
    if (!normalized) {
      throw new BadRequestException("SPEAKING promptPayload.speakingPrompt is required and cannot be empty.");
    }

    const wordCount = this.countWords(normalized);
    const directiveCount = this.countPromptDirectives(normalized);
    const lower = normalized.toLowerCase();
    const hasQuestionMark = normalized.includes("?");
    const hasRoleplayLead = lower.startsWith("imagine ") || lower.includes("imagine a student is meeting");
    const overloadedDirectiveChain =
      /(summarize|describe|state whether|evaluate|explain).*(summarize|describe|state whether|evaluate|explain)/i.test(normalized) &&
      directiveCount > 2;

    if (wordCount < 12 || wordCount > 55 || !hasQuestionMark || hasRoleplayLead || overloadedDirectiveChain) {
      throw new BadRequestException(
        "Generated speakingPrompt failed quality constraints (length/question clarity/anti-roleplay/anti-overload).",
      );
    }

    return normalized;
  }

  private countPromptDirectives(prompt: string): number {
    const matches = prompt.match(/\b(summarize|describe|state|explain|compare|discuss|argue|justify|evaluate|choose|support)\b/gi);
    return matches ? matches.length : 0;
  }

  private ensureMinimumWords(value: string, minimumWords: number, fieldLabel: string): string {
    const cleaned = value.trim();
    if (!cleaned) {
      throw new BadRequestException(`${fieldLabel} is missing in provider output.`);
    }

    const wordCount = this.countWords(cleaned);
    if (wordCount < minimumWords) {
      throw new BadRequestException(
        `${fieldLabel} is too short: expected at least ${minimumWords} words, got ${wordCount}.`,
      );
    }

    return cleaned;
  }

  private requireNonEmptyText(value: string, fieldLabel: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      throw new BadRequestException(`${fieldLabel} is required and cannot be empty.`);
    }
    return normalized;
  }

  private requireNonEmptyFormattedText(value: string, fieldLabel: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new BadRequestException(`${fieldLabel} is required and cannot be empty.`);
    }
    return trimmed;
  }

  private async waitMs(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), Math.max(0, Math.round(ms)));
    });
  }

  private countWords(value: string): number {
    const normalized = value.trim();
    if (!normalized) {
      return 0;
    }
    return normalized.split(/\s+/).length;
  }

  private sortItemsForDelivery(items: TestItem[]): TestItem[] {
    return [...items].sort((a, b) => {
      const aIndex = this.extractQuestionIndex(a.metadataJson);
      const bIndex = this.extractQuestionIndex(b.metadataJson);
      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  private extractQuestionIndex(metadata: Prisma.JsonValue): number {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return Number.MAX_SAFE_INTEGER;
    }

    const rawIndex = (metadata as Record<string, unknown>).questionIndex;
    return typeof rawIndex === "number" && Number.isFinite(rawIndex) ? rawIndex : Number.MAX_SAFE_INTEGER;
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

  private safeParseObject(input: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(input);
      return this.asObject(parsed);
    } catch {
      return null;
    }
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

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }

  private readObjectArray(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => this.asObject(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }

  private normalizeSeconds(value: unknown, fallback: number, min: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(min, Math.round(value));
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.max(min, Math.round(parsed));
      }
    }
    return Math.max(min, Math.round(fallback));
  }

  private pickTaskType(sectionType: SectionType): string {
    switch (sectionType) {
      case "READING":
        return "read_academic_passage";
      case "LISTENING":
        return "listen_conversation";
      case "SPEAKING":
        return "take_interview";
      case "WRITING":
        return "write_academic_discussion";
      default:
        return "generic_task";
    }
  }

  private extractTopic(metadata: Prisma.JsonValue): string {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return "unknown";
    }

    const topic = (metadata as Record<string, unknown>).topic;
    return typeof topic === "string" && topic.length > 0 ? topic : "unknown";
  }

}
