import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { join } from "path";
import GraphQLJSON from "graphql-type-json";
import { HealthController } from "./health.controller";
import { AudioController } from "./audio.controller";
import { SpeechController } from "./speech.controller";
import { PrismaService } from "./prisma.service";
import { SessionResolver } from "./graphql/session.resolver";
import { CryptoService } from "./services/crypto.service";
import { ProviderConfigService } from "./services/provider-config.service";
import { SessionService } from "./services/session.service";
import { GenerationService } from "./services/generation.service";
import { ReportService } from "./services/report.service";
import { SpeechAnalysisService } from "./services/speech-analysis.service";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), "schema.gql"),
      resolvers: { JSON: GraphQLJSON },
      playground: true,
    }),
  ],
  controllers: [HealthController, AudioController, SpeechController],
  providers: [
    PrismaService,
    SessionResolver,
    CryptoService,
    ProviderConfigService,
    SessionService,
    GenerationService,
    ReportService,
    SpeechAnalysisService,
  ],
})
export class AppModule {}
