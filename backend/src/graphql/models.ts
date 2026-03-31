import { Field, Float, ID, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import GraphQLJSON from "graphql-type-json";
import { Prisma, SectionType, SessionStatus } from "@prisma/client";

registerEnumType(SessionStatus, { name: "SessionStatus" });

registerEnumType(SectionType, { name: "SectionType" });

@ObjectType()
export class ProviderConfigModel {
  @Field(() => ID)
  id!: string;

  @Field()
  baseUrl!: string;

  @Field()
  model!: string;

  @Field()
  maskedApiKey!: string;

  @Field()
  isActive!: boolean;
}

@ObjectType()
export class TestItemModel {
  @Field(() => ID)
  id!: string;

  @Field()
  taskType!: string;

  @Field(() => GraphQLJSON)
  promptPayload!: Prisma.JsonValue;

  @Field(() => String, { nullable: true })
  audioUrl!: string | null;
}

@ObjectType()
export class SectionInstanceModel {
  @Field(() => ID)
  id!: string;

  @Field(() => SectionType)
  sectionType!: SectionType;

  @Field(() => Int)
  orderIndex!: number;

  @Field(() => Int)
  timeLimitSeconds!: number;

  @Field(() => Float, { nullable: true })
  score1to6!: number | null;
}

@ObjectType()
export class TestSessionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => SessionStatus)
  status!: SessionStatus;

  @Field(() => Float, { nullable: true })
  overallScore1to6!: number | null;

  @Field(() => Float, { nullable: true })
  overallScore0to120!: number | null;

  @Field(() => [SectionInstanceModel], { nullable: true })
  sections?: SectionInstanceModel[];
}

@ObjectType()
export class AnalysisReportModel {
  @Field(() => ID)
  id!: string;

  @Field(() => GraphQLJSON)
  reportJson!: Prisma.JsonValue;

  @Field(() => String, { nullable: true })
  pdfUrl!: string | null;
}

@ObjectType()
export class RecentResultSectionScoreModel {
  @Field(() => SectionType)
  sectionType!: SectionType;

  @Field(() => Float)
  score!: number;
}

@ObjectType()
export class RecentResultModel {
  @Field(() => ID)
  reportId!: string;

  @Field(() => ID)
  sessionId!: string;

  @Field(() => String)
  createdAt!: string;

  @Field(() => Float, { nullable: true })
  overallScore1to6!: number | null;

  @Field(() => Float, { nullable: true })
  overallScore0to120!: number | null;

  @Field(() => [RecentResultSectionScoreModel])
  sectionScores!: RecentResultSectionScoreModel[];
}
