import { Injectable } from "@nestjs/common";
import { ProviderConfig } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { SaveProviderConfigInput } from "../graphql/inputs";
import { CryptoService } from "./crypto.service";

@Injectable()
export class ProviderConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cryptoService: CryptoService,
  ) {}

  async save(input: SaveProviderConfigInput): Promise<ProviderConfig> {
    await this.prisma.providerConfig.updateMany({ data: { isActive: false } });
    return this.prisma.providerConfig.create({
      data: {
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyEncrypted: this.cryptoService.encrypt(input.apiKey),
        isActive: true,
      },
    });
  }

  async getActive(): Promise<ProviderConfig | null> {
    return this.prisma.providerConfig.findFirst({ where: { isActive: true } });
  }

  async getActiveWithApiKey(): Promise<{ id: string; baseUrl: string; model: string; apiKey: string } | null> {
    const active = await this.getActive();
    if (!active) {
      return null;
    }

    return {
      id: active.id,
      baseUrl: active.baseUrl,
      model: active.model,
      apiKey: this.cryptoService.decrypt(active.apiKeyEncrypted),
    };
  }

  async testConnection(input: SaveProviderConfigInput): Promise<boolean> {
    return input.baseUrl.length > 0 && input.apiKey.length > 0 && input.model.length > 0;
  }

  mask(config: ProviderConfig): { id: string; baseUrl: string; model: string; maskedApiKey: string; isActive: boolean } {
    const decrypted = this.cryptoService.decrypt(config.apiKeyEncrypted);
    return {
      id: config.id,
      baseUrl: config.baseUrl,
      model: config.model,
      maskedApiKey: this.cryptoService.maskSecret(decrypted),
      isActive: config.isActive,
    };
  }
}
