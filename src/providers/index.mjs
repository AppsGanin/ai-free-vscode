import { DeepSeekProvider } from "./deepseek.mjs";
import { QwenProvider } from "./qwen.mjs";

const providers = {
  deepseek: new DeepSeekProvider(),
  qwen: new QwenProvider(),
};

/**
 * Возвращает экземпляр провайдера по его имени.
 * @param {string} name - Имя провайдера ('deepseek', 'qwen', и т.д.)
 * @returns {AIProvider} Экземпляр провайдера
 */
export function getProvider(name) {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

/**
 * Возвращает список всех доступных провайдеров.
 * @returns {Array<{name: string, provider: AIProvider}>}
 */
export function getAllProviders() {
  return Object.entries(providers).map(([name, provider]) => ({
    name,
    provider,
  }));
}
