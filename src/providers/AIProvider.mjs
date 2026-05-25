/**
 * Базовый интерфейс для всех AI-провайдеров.
 * Все конкретные провайдеры должны реализовывать этот интерфейс.
 */
export class AIProvider {
  /**
   * Возвращает список доступных моделей этого провайдера.
   * @returns {Array<{id: string, family: string, displayName: string, description: string}>}
   */
  getModels() {
    throw new Error("Method not implemented");
  }

  /**
   * Выполняет аутентификацию через браузер и сохраняет сессию.
   * @returns {Promise<{auth: any}>} Объект с данными аутентификации
   */
  async login() {
    throw new Error("Method not implemented");
  }

  /**
   * Очищает данные аутентификации.
   */
  logout() {
    throw new Error("Method not implemented");
  }

  /**
   * Загружает сохраненные данные аутентификации.
   * @returns {any|null} Данные аутентификации или null, если их нет
   */
  loadAuth() {
    throw new Error("Method not implemented");
  }

  /**
   * Выполняет запрос к модели и обрабатывает потоковый ответ.
   * @param {Object} params - Параметры запроса
   * @param {string} params.modelId - ID модели
   * @param {string} params.prompt - Подготовленный промпт
   * @param {Object} params.auth - Данные аутентификации
   * @param {Function} params.onText - Колбэк для обработки текстовых фрагментов
   * @param {Function} [params.onThinking] - Колбэк для обработки мыслительных процессов
   * @param {Object} params.signal - AbortSignal для отмены запроса
   * @param {string} params.threadKey - Ключ для сохранения контекста диалога
   * @param {number} params.messagesCount - Количество сообщений в диалоге
   */
  async complete({
    modelId,
    prompt,
    auth,
    onText,
    onThinking,
    signal,
    threadKey,
    messagesCount,
  }) {
    throw new Error("Method not implemented");
  }
}
