import { BadRequestException, Controller, Get, NotFoundException, Param, StreamableFile } from "@nestjs/common";
import { createReadStream, existsSync } from "fs";
import { join } from "path";

@Controller("audio")
export class AudioController {
  private readonly audioDirectory = process.env.AUDIO_STORAGE_DIR || join(process.cwd(), "generated-audio");

  @Get(":fileName")
  streamAudio(@Param("fileName") fileName: string): StreamableFile {
    if (!/^[a-zA-Z0-9._-]+\.mp3$/i.test(fileName)) {
      throw new BadRequestException("Invalid audio file name.");
    }

    const fullPath = join(this.audioDirectory, fileName);
    if (!existsSync(fullPath)) {
      throw new NotFoundException("Audio file not found.");
    }

    const stream = createReadStream(fullPath);
    return new StreamableFile(stream, {
      type: "audio/mpeg",
      disposition: `inline; filename="${fileName}"`,
    });
  }
}
