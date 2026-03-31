import { Args, Int, Mutation, Query, Resolver } from "@nestjs/graphql";
import { SaveAnswerInput, SaveProviderConfigInput, StartSessionInput, NextTaskInput } from "./inputs";
import { AnalysisReportModel, ProviderConfigModel, RecentResultModel, TestItemModel, TestSessionModel } from "./models";
import { ProviderConfigService } from "../services/provider-config.service";
import { SessionService } from "../services/session.service";
import { GenerationService } from "../services/generation.service";
import { ReportService } from "../services/report.service";

@Resolver()
export class SessionResolver {
  constructor(
    private readonly providerConfigService: ProviderConfigService,
    private readonly sessionService: SessionService,
    private readonly generationService: GenerationService,
    private readonly reportService: ReportService,
  ) {}

  @Query(() => ProviderConfigModel, { nullable: true })
  async activeProviderConfig(): Promise<ProviderConfigModel | null> {
    const active = await this.providerConfigService.getActive();
    return active ? this.providerConfigService.mask(active) : null;
  }

  @Mutation(() => ProviderConfigModel)
  async saveProviderConfig(@Args("input") input: SaveProviderConfigInput): Promise<ProviderConfigModel> {
    const config = await this.providerConfigService.save(input);
    return this.providerConfigService.mask(config);
  }

  @Mutation(() => Boolean)
  async testProviderConnection(@Args("input") input: SaveProviderConfigInput): Promise<boolean> {
    return this.providerConfigService.testConnection(input);
  }

  @Mutation(() => TestSessionModel)
  async startSession(@Args("input", { nullable: true }) input?: StartSessionInput): Promise<TestSessionModel> {
    return this.sessionService.startSession(input?.blueprintCode);
  }

  @Query(() => TestSessionModel, { nullable: true })
  async session(@Args("id") id: string): Promise<TestSessionModel | null> {
    return this.sessionService.getSession(id);
  }

  @Query(() => [RecentResultModel])
  async recentResults(@Args("limit", { type: () => Int, nullable: true }) limit?: number): Promise<RecentResultModel[]> {
    return this.reportService.listRecentResults(limit);
  }

  @Mutation(() => TestItemModel)
  async nextTask(@Args("input") input: NextTaskInput): Promise<TestItemModel> {
    return this.generationService.nextTask(input.sessionId, input.sectionInstanceId);
  }

  @Mutation(() => Boolean)
  async saveAnswer(@Args("input") input: SaveAnswerInput): Promise<boolean> {
    await this.sessionService.saveAnswer(input);
    return true;
  }

  @Mutation(() => AnalysisReportModel)
  async generateReport(@Args("sessionId") sessionId: string): Promise<AnalysisReportModel> {
    return this.reportService.generateReport(sessionId);
  }

  @Mutation(() => TestSessionModel)
  async completeSession(@Args("sessionId") sessionId: string): Promise<TestSessionModel> {
    return this.sessionService.completeSession(sessionId);
  }
}
