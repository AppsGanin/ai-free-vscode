export interface ProviderModelIdResolver {
  resolveModelId: (id: string) => string;
  toApiModelType: (id: string) => string;
}

export function createProviderModelIdResolver(params: {
  aliases?: Record<string, string>;
  apiModelTypeByModelId?: Record<string, string>;
}): ProviderModelIdResolver {
  const aliases = Object.fromEntries(
    Object.entries(params.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  const apiModelTypeByModelId = Object.fromEntries(
    Object.entries(params.apiModelTypeByModelId ?? {}).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );

  const resolveModelId = (id: string): string => {
    const lower = id.toLowerCase();
    return aliases[lower] ?? id;
  };

  const toApiModelType = (id: string): string => {
    const resolved = resolveModelId(id);
    return apiModelTypeByModelId[resolved.toLowerCase()] ?? resolved;
  };

  return {
    resolveModelId,
    toApiModelType,
  };
}
