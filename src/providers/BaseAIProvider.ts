import * as vscode from "vscode";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "./types";

/**
 * Базовый абстрактный класс для всех AI-провайдеров.
 *
 * Чтобы добавить нового провайдера:
 * 1. Создать папку `src/providers/<name>/`
 * 2. Реализовать класс extends BaseAIProvider
 * 3. Добавить в extension.ts одну строку регистрации
 * 4. Добавить запись в package.json → contributes.languageModelChatProviders
 */
export abstract class BaseAIProvider implements vscode.Disposable {
  /** Уникальный строковый идентификатор провайдера (совпадает с vendor в package.json) */
  abstract readonly id: string;

  /** Человекочитаемое имя, отображается в UI */
  abstract readonly displayName: string;

  /**
   * EventEmitter для уведомления о смене состояния авторизации.
   * Расширение подпишется и обновит состояние команд.
   */
  protected readonly _onDidAuthChange = new vscode.EventEmitter<void>();
  readonly onDidAuthChange: vscode.Event<void> = this._onDidAuthChange.event;

  /** Возвращает список моделей данного провайдера */
  abstract getModels(): AIModelInfo[];

  /**
   * Возвращает модели, которые реально доступны с учётом авторизации.
   * По умолчанию: все модели, если провайдер авторизован, иначе пустой список.
   * Композитные провайдеры переопределяют, чтобы фильтровать по под-провайдерам.
   */
  async getAvailableModels(
    secrets: vscode.SecretStorage,
  ): Promise<AIModelInfo[]> {
    return (await this.isAuthenticated(secrets)) ? this.getModels() : [];
  }

  /**
   * Проверяет, авторизован ли пользователь.
   * Должна быть быстрой (не делать сетевых запросов — только SecretStorage).
   */
  abstract isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean>;

  /**
   * Запускает flow авторизации (Playwright, API-key диалог, OAuth и т.д.).
   * По завершении сохраняет токен в secrets и вызывает _onDidAuthChange.fire().
   */
  abstract login(secrets: vscode.SecretStorage): Promise<void>;

  /** Удаляет токен из SecretStorage, вызывает _onDidAuthChange.fire() */
  abstract logout(secrets: vscode.SecretStorage): Promise<void>;

  /**
   * Отправляет запрос и возвращает стриминговый AsyncIterable.
   * Должен выбрасывать AuthExpiredError / RateLimitError / ProviderError при ошибках.
   */
  abstract sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk>;

  dispose(): void {
    this._onDidAuthChange.dispose();
  }
}
