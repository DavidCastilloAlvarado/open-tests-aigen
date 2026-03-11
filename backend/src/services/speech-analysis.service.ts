import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ProviderConfigService } from "./provider-config.service";

type AnalyzeSpeakingAudioArgs = {
  audioBuffer: Buffer;
  fileName: string;
  mimeType: string;
  speakingPrompt?: string;
};

@Injectable()
export class SpeechAnalysisService {
  private readonly logger = new Logger(SpeechAnalysisService.name);

  constructor(private readonly providerConfigService: ProviderConfigService) {}

  async analyzeSpeakingAudio(args: AnalyzeSpeakingAudioArgs): Promise<{
    transcript: string;
    analysis: string;
    transcriptionModel: string;
    analysisModel: string;
  }> {
    const activeConfig = await this.providerConfigService.getActiveWithApiKey();
    if (!activeConfig) {
      throw new BadRequestException("No active provider configuration. Save endpoint and API key on Home first.");
    }

    const transcript = await this.transcribeAudio({
      baseUrl: activeConfig.baseUrl,
      apiKey: activeConfig.apiKey,
      audioBuffer: args.audioBuffer,
      fileName: args.fileName,
      mimeType: args.mimeType,
    });

    const analysisModel = activeConfig.model || "gpt-4.1-mini";
    const analysis = await this.analyzeTranscript({
      baseUrl: activeConfig.baseUrl,
      apiKey: activeConfig.apiKey,
      model: analysisModel,
      transcript,
      speakingPrompt: args.speakingPrompt,
    });

    return {
      transcript,
      analysis,
      transcriptionModel: this.transcriptionModel(),
      analysisModel,
    };
  }

  private async transcribeAudio(args: {
    baseUrl: string;
    apiKey: string;
    audioBuffer: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<string> {
    const audioArrayBuffer = new ArrayBuffer(args.audioBuffer.byteLength);
    new Uint8Array(audioArrayBuffer).set(args.audioBuffer);

    const candidates = [
      ...this.transcriptionRequestCandidates(args.baseUrl, args.apiKey),
      {
        endpoint: this.openAiTranscriptionEndpoint(args.baseUrl),
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
        },
      },
    ];

    const dedupedCandidates: Array<{ endpoint: string; headers: Record<string, string> }> = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = candidate.endpoint.trim();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      dedupedCandidates.push({ endpoint: key, headers: candidate.headers });
    }

    let lastError = "";
    for (const candidate of dedupedCandidates) {
      const response = await this.requestTranscription({
        endpoint: candidate.endpoint,
        headers: candidate.headers,
        audioArrayBuffer,
        fileName: args.fileName,
        mimeType: args.mimeType,
      });

      if (response.ok) {
        const transcript = this.extractTranscript(response.payload);
        if (transcript) {
          return transcript;
        }
        lastError = `Transcription service returned an empty transcript at ${candidate.endpoint}.`;
        continue;
      }

      lastError = `${candidate.endpoint} -> ${response.errorText}`;
    }

    if (!lastError) {
      lastError =
        "Transcription request failed. Check provider base URL and transcription deployment availability.";
    }

    if (/resource not found/i.test(lastError)) {
      lastError = `${lastError} Verify AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT or set AZURE_OPENAI_TRANSCRIBE_ENDPOINT explicitly.`;
    }

    throw new BadRequestException(lastError);
  }

  private async analyzeTranscript(args: {
    baseUrl: string;
    apiKey: string;
    model: string;
    transcript: string;
    speakingPrompt?: string;
  }): Promise<string> {
    const normalizedBaseUrl = this.normalizeApiBaseUrl(args.baseUrl);
    const openAiCompatibleEndpoint = `${normalizedBaseUrl}/responses`;
    const azureEndpoint = this.azureResponsesEndpoint(args.baseUrl, args.model);
    const reasoningEffort = this.reasoningEffortForModel(args.model, "high");
    const promptContext = args.speakingPrompt?.trim()
      ? `Speaking prompt:\n${args.speakingPrompt.trim()}\n\n`
      : "";

    const messages = [
      {
        role: "system",
        content:
          "You are a TOEFL speaking evaluator. Provide concise feedback on fluency, coherence, lexical range, grammar, and pronunciation indicators from transcript evidence. Output plain text.",
      },
      {
        role: "user",
        content:
          `${promptContext}Transcript:\n${args.transcript}\n\nRespond with:\n1) Overall impression (1 short paragraph)\n2) Strengths (bullet list)\n3) Weak points (bullet list)\n4) Concrete improvement tips (bullet list)`,
      },
    ];

    const openAiStartedAt = Date.now();
    this.logger.log(
      `[OpenAI Request] speaking_analysis endpoint=${openAiCompatibleEndpoint} model=${args.model} transcript_chars=${args.transcript.length}`,
    );
    try {
      const openAiResponse = await fetch(openAiCompatibleEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: args.model,
          input: messages,
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

      if (openAiResponse.ok) {
        const openAiPayload = (await openAiResponse.json()) as unknown;
        const openAiContent = this.extractResponsesOutputText(openAiPayload);
        if (openAiContent) {
          this.logger.log(
            `[OpenAI Response] speaking_analysis success status=${openAiResponse.status} duration_ms=${Date.now() - openAiStartedAt} endpoint=${openAiCompatibleEndpoint}`,
          );
          return openAiContent;
        }
        this.logger.warn(
          `[OpenAI Response] speaking_analysis missing_content status=${openAiResponse.status} duration_ms=${Date.now() - openAiStartedAt} endpoint=${openAiCompatibleEndpoint}`,
        );
      } else {
        const details = await openAiResponse.text().catch(() => "");
        this.logger.warn(
          `[OpenAI Response] speaking_analysis status=${openAiResponse.status} duration_ms=${Date.now() - openAiStartedAt} endpoint=${openAiCompatibleEndpoint} details=${details.slice(0, 220) || "empty response body"}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown network error";
      this.logger.warn(
        `[OpenAI Request] speaking_analysis network_error duration_ms=${Date.now() - openAiStartedAt} endpoint=${openAiCompatibleEndpoint} message=${message}`,
      );
      // Try Azure endpoint fallback below.
    }

    let azureResponse: Response;
    const azureStartedAt = Date.now();
    this.logger.log(
      `[OpenAI Request] speaking_analysis_azure endpoint=${azureEndpoint} model=${args.model} transcript_chars=${args.transcript.length}`,
    );
    try {
      azureResponse = await fetch(azureEndpoint, {
        method: "POST",
        headers: {
          "api-key": args.apiKey,
          Authorization: `Bearer ${args.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: messages,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown network error";
      this.logger.warn(
        `[OpenAI Request] speaking_analysis_azure network_error duration_ms=${Date.now() - azureStartedAt} endpoint=${azureEndpoint} message=${message}`,
      );
      return "Transcript captured. Automatic speaking analysis is currently unavailable.";
    }

    if (!azureResponse.ok) {
      const details = await azureResponse.text();
      this.logger.warn(
        `[OpenAI Response] speaking_analysis_azure status=${azureResponse.status} duration_ms=${Date.now() - azureStartedAt} endpoint=${azureEndpoint}`,
      );
      return details || "Transcript captured. Automatic speaking analysis is currently unavailable.";
    }

    const payload = (await azureResponse.json()) as unknown;
    const content = this.extractResponsesOutputText(payload);
    this.logger.log(
      `[OpenAI Response] speaking_analysis_azure success status=${azureResponse.status} duration_ms=${Date.now() - azureStartedAt} endpoint=${azureEndpoint}`,
    );
    return content || "Transcript captured. Automatic speaking analysis is currently unavailable.";
  }

  private azureTranscriptionEndpoint(baseUrl: string): string {
    const withOpenAiRoot = this.azureOpenAiRoot(baseUrl);
    const deployment = process.env.AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT?.trim() || "gpt-4o-transcribe";
    const apiVersion = this.azureApiVersion();

    const withPath = /\/deployments\/[^/]+\/audio\/transcriptions$/i.test(withOpenAiRoot)
      ? withOpenAiRoot
      : `${withOpenAiRoot}/deployments/${encodeURIComponent(deployment)}/audio/transcriptions`;

    return withPath.includes("?")
      ? `${withPath}&api-version=${encodeURIComponent(apiVersion)}`
      : `${withPath}?api-version=${encodeURIComponent(apiVersion)}`;
  }

  private azureResponsesEndpoint(baseUrl: string, deployment: string): string {
    const withOpenAiRoot = this.azureOpenAiRoot(baseUrl);
    const apiVersion = this.azureApiVersion();
    const withPath = `${withOpenAiRoot}/deployments/${encodeURIComponent(deployment)}/responses`;
    return withPath.includes("?")
      ? `${withPath}&api-version=${encodeURIComponent(apiVersion)}`
      : `${withPath}?api-version=${encodeURIComponent(apiVersion)}`;
  }

  private azureOpenAiRoot(baseUrl: string): string {
    const normalized = this.normalizeApiBaseUrl(baseUrl);
    const withOpenAiRoot = /\/openai(\/|$)/i.test(normalized) ? normalized : `${normalized}/openai`;
    const withoutVersionSuffix = withOpenAiRoot.replace(/\/openai\/v\d+$/i, "/openai");
    return withoutVersionSuffix.replace(/\/deployments\/[^/]+(?:\/.*)?$/i, "");
  }

  private openAiTranscriptionEndpoint(baseUrl: string): string {
    const normalized = this.normalizeApiBaseUrl(baseUrl);
    if (/\/audio\/transcriptions$/i.test(normalized)) {
      return normalized;
    }
    return `${normalized}/audio/transcriptions`;
  }

  private normalizeApiBaseUrl(baseUrl: string): string {
    const withoutQuery = baseUrl.trim().split("?")[0].replace(/\/+$/, "");
    return withoutQuery
      .replace(/\/chat\/completions$/i, "")
      .replace(/\/responses$/i, "")
      .replace(/\/audio\/speech$/i, "")
      .replace(/\/audio\/transcriptions$/i, "");
  }

  private reasoningEffortForModel(model: string, preferred: "minimal" | "medium" | "high"): "minimal" | "medium" | "high" {
    const normalized = model.trim().toLowerCase();
    if (normalized.includes("gpt-5.3-chat")) {
      return "medium";
    }
    return preferred;
  }

  private azureApiVersion(): string {
    return process.env.AZURE_OPENAI_API_VERSION?.trim() || "2025-03-01-preview";
  }

  private transcriptionModel(): string {
    return process.env.SPEECH_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-transcribe";
  }

  private transcriptionRequestCandidates(
    baseUrl: string,
    apiKey: string,
  ): Array<{ endpoint: string; headers: Record<string, string> }> {
    const candidates: Array<{ endpoint: string; headers: Record<string, string> }> = [];

    const explicitEndpoint =
      process.env.AZURE_OPENAI_TRANSCRIBE_ENDPOINT?.trim() || process.env.SPEECH_TRANSCRIBE_ENDPOINT?.trim() || "";
    if (explicitEndpoint) {
      candidates.push({
        endpoint: explicitEndpoint,
        headers: {
          "api-key": apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
      });
    }

    if (this.isAzureBaseUrl(baseUrl)) {
      candidates.push({
        endpoint: this.azureTranscriptionEndpoint(baseUrl),
        headers: {
          "api-key": apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
      });
    }

    return candidates;
  }

  private isAzureBaseUrl(baseUrl: string): boolean {
    const normalized = this.normalizeApiBaseUrl(baseUrl).toLowerCase();
    return normalized.includes(".openai.azure.com") || normalized.includes(".cognitiveservices.azure.com");
  }

  private async requestTranscription(args: {
    endpoint: string;
    headers: Record<string, string>;
    audioArrayBuffer: ArrayBuffer;
    fileName: string;
    mimeType: string;
  }): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; errorText: string }> {
    const formData = new FormData();
    formData.append("model", this.transcriptionModel());
    formData.append(
      "file",
      new Blob([args.audioArrayBuffer], { type: args.mimeType || "audio/webm" }),
      args.fileName || "speaking-response.webm",
    );

    const requestStartedAt = Date.now();
    this.logger.log(
      `[OpenAI Request] transcription endpoint=${args.endpoint} model=${this.transcriptionModel()} file=${args.fileName || "speaking-response.webm"} bytes=${args.audioArrayBuffer.byteLength}`,
    );

    let response: Response;
    try {
      response = await fetch(args.endpoint, {
        method: "POST",
        headers: args.headers,
        body: formData,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error while calling transcription endpoint.";
      this.logger.warn(
        `[OpenAI Request] transcription network_error duration_ms=${Date.now() - requestStartedAt} endpoint=${args.endpoint} message=${message}`,
      );
      return {
        ok: false,
        errorText: message,
      };
    }

    if (!response.ok) {
      const details = await response.text();
      this.logger.warn(
        `[OpenAI Response] transcription status=${response.status} duration_ms=${Date.now() - requestStartedAt} endpoint=${args.endpoint}`,
      );
      return {
        ok: false,
        errorText: details || `Transcription request failed with status ${response.status}.`,
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    this.logger.log(
      `[OpenAI Response] transcription success status=${response.status} duration_ms=${Date.now() - requestStartedAt} endpoint=${args.endpoint}`,
    );
    return { ok: true, payload };
  }

  private extractTranscript(payload: Record<string, unknown>): string {
    return this.readString(payload.text) || this.readString(payload.transcript) || this.readString(payload.display_text);
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

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private readObjectArray(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => this.asObject(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }

  private readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}
