import { BadRequestException, Body, Controller, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { SpeechAnalysisService } from "./services/speech-analysis.service";

@Controller("speech")
export class SpeechController {
  constructor(private readonly speechAnalysisService: SpeechAnalysisService) {}

  @Post("analyze")
  @UseInterceptors(FileInterceptor("file"))
  async analyzeSpeech(
    @UploadedFile() file: { buffer: Buffer; originalname?: string; mimetype?: string } | undefined,
    @Body("speakingPrompt") speakingPrompt?: string,
  ): Promise<{ transcript: string; analysis: string; transcriptionModel: string; analysisModel: string }> {
    if (!file?.buffer || file.buffer.byteLength === 0) {
      throw new BadRequestException("Audio file is required for speaking analysis.");
    }

    return this.speechAnalysisService.analyzeSpeakingAudio({
      audioBuffer: file.buffer,
      fileName: file.originalname || "speaking-response.webm",
      mimeType: file.mimetype || "audio/webm",
      speakingPrompt,
    });
  }
}
