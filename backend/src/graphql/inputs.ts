import { Field, ID, InputType } from "@nestjs/graphql";
import GraphQLJSON from "graphql-type-json";
import { Prisma } from "@prisma/client";

@InputType()
export class SaveProviderConfigInput {
  @Field()
  baseUrl!: string;

  @Field()
  apiKey!: string;

  @Field()
  model!: string;
}

@InputType()
export class StartSessionInput {
  @Field({ nullable: true })
  blueprintCode?: string;
}

@InputType()
export class NextTaskInput {
  @Field(() => ID)
  sessionId!: string;

  @Field(() => ID)
  sectionInstanceId!: string;
}

@InputType()
export class SaveAnswerInput {
  @Field(() => ID)
  sessionId!: string;

  @Field(() => ID)
  sectionInstanceId!: string;

  @Field(() => ID)
  testItemId!: string;

  @Field(() => GraphQLJSON)
  responsePayload!: Prisma.InputJsonValue;
}
