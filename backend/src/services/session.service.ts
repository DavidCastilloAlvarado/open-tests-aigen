import { Injectable } from "@nestjs/common";
import { Prisma, SectionType, SessionStatus } from "@prisma/client";
import { PrismaService } from "../prisma.service";

const DEFAULT_BLUEPRINT_CODE = "toefl_ibt_2026_v1";

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaultBlueprint(): Promise<string> {
    const existing = await this.prisma.examBlueprint.findUnique({ where: { code: DEFAULT_BLUEPRINT_CODE } });
    if (existing) {
      return existing.id;
    }
    const created = await this.prisma.examBlueprint.create({
      data: {
        code: DEFAULT_BLUEPRINT_CODE,
        isActive: true,
        configJson: {
          sections: [
            { sectionType: "READING", timeLimitSeconds: 1620 },
            { sectionType: "LISTENING", timeLimitSeconds: 2100 },
            { sectionType: "SPEAKING", timeLimitSeconds: 1020 },
            { sectionType: "WRITING", timeLimitSeconds: 1740 },
          ],
        },
      },
    });
    return created.id;
  }

  async startSession(blueprintCode?: string) {
    let blueprint = await this.prisma.examBlueprint.findUnique({ where: { code: blueprintCode || DEFAULT_BLUEPRINT_CODE } });
    if (!blueprint) {
      const defaultId = await this.ensureDefaultBlueprint();
      blueprint = await this.prisma.examBlueprint.findUniqueOrThrow({ where: { id: defaultId } });
    }

    const sections = (blueprint.configJson as { sections: { sectionType: SectionType; timeLimitSeconds: number }[] }).sections;
    const session = await this.prisma.testSession.create({
      data: {
        blueprintId: blueprint.id,
        status: SessionStatus.IN_PROGRESS,
        sections: {
          create: sections.map((section, index) => ({
            sectionType: section.sectionType,
            orderIndex: index,
            timeLimitSeconds: section.timeLimitSeconds,
            startedAt: index === 0 ? new Date() : null,
          })),
        },
      },
      include: { sections: true },
    });

    return session;
  }

  async getSession(sessionId: string) {
    return this.prisma.testSession.findUnique({
      where: { id: sessionId },
      include: { sections: true },
    });
  }

  async completeSession(sessionId: string) {
    return this.prisma.testSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.COMPLETED, completedAt: new Date() },
    });
  }

  async saveAnswer(input: {
    sessionId: string;
    sectionInstanceId: string;
    testItemId: string;
    responsePayload: Prisma.InputJsonValue;
  }) {
    await this.prisma.sessionEvent.create({
      data: {
        sessionId: input.sessionId,
        eventType: "answer_saved",
        payload: { sectionInstanceId: input.sectionInstanceId, testItemId: input.testItemId },
      },
    });

    await this.prisma.answer.deleteMany({ where: { testItemId: input.testItemId } });

    return this.prisma.answer.create({
      data: {
        testItemId: input.testItemId,
        responsePayload: input.responsePayload,
      },
    });
  }
}
