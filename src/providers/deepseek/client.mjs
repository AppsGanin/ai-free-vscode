import { httpsRequest, readBody } from "../../utils/https.mjs";
import { BASE_URL, COMPLETION_PATH } from "./config.mjs";
import { baseHeaders } from "./headers.mjs";
import { solvePow } from "./pow.mjs";
import { streamSseFromNodeResponse } from "./sse.mjs";

export class DeepSeekClient {
  constructor({ cookieHeader, token, debug = false }) {
    this.cookieHeader = cookieHeader;
    this.token = token;
    this.debug = debug;
  }

  _buildHeaders() {
    return baseHeaders(this.cookieHeader, this.token);
  }

  async _request(path, { method = "GET", body, signal } = {}) {
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    const headers = this._buildHeaders();
    if (bodyStr !== undefined) {
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const res = await httpsRequest(
      `${BASE_URL}${path}`,
      method,
      headers,
      bodyStr,
      signal,
    );
    const text = await readBody(res);
    const status = res.statusCode;

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (status === 401 || status === 403) {
        const err = new Error(`Auth required: HTTP ${status}`);
        err.isAuthError = true;
        throw err;
      }
      throw new Error(
        `Expected JSON from ${path}, got HTTP ${status}: ${text.slice(0, 180)}`,
      );
    }

    if (
      status === 401 ||
      status === 403 ||
      (json && (json.code === 40002 || json.code === 40003))
    ) {
      const err = new Error(`Auth required: code ${json?.code ?? ""}`);
      err.isAuthError = true;
      throw err;
    }

    if (
      status < 200 ||
      status >= 300 ||
      (json.code !== undefined && json.code !== 0)
    ) {
      throw new Error(
        `DeepSeek API error at ${path}: HTTP ${status}, code ${json.code}, msg ${json.msg || ""}`,
      );
    }

    return json;
  }

  async createSession({ signal } = {}) {
    const json = await this._request("/api/v0/chat_session/create", {
      method: "POST",
      body: {},
      signal,
    });
    // API returns id either directly in biz_data or nested in chat_session
    const biz = json?.data?.biz_data;
    const sessionId = biz?.id ?? biz?.chat_session?.id;
    if (!sessionId)
      throw new Error(
        `Cannot read chat session id: ${JSON.stringify(json).slice(0, 300)}`,
      );
    return sessionId;
  }

  async createPowHeader(targetPath, { signal } = {}) {
    const json = await this._request("/api/v0/chat/create_pow_challenge", {
      method: "POST",
      body: { target_path: targetPath },
      signal,
    });

    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge)
      throw new Error(
        `Cannot read PoW challenge: ${JSON.stringify(json).slice(0, 300)}`,
      );

    const answer = await solvePow(challenge);
    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }

  async complete({
    sessionId,
    prompt,
    parentMessageId = null,
    modelType = null,
    thinkingEnabled = false,
    searchEnabled = false,
    onText = null,
    signal = undefined,
  }) {
    const pow = await this.createPowHeader(COMPLETION_PATH, { signal });
    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      preempt: false,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
    };

    const bodyStr = JSON.stringify(body);
    const headers = {
      ...this._buildHeaders(),
      "X-DS-PoW-Response": pow,
      "Content-Length": String(Buffer.byteLength(bodyStr)),
    };

    const res = await httpsRequest(
      `${BASE_URL}${COMPLETION_PATH}`,
      "POST",
      headers,
      bodyStr,
      signal,
    );
    const status = res.statusCode;
    const contentType = String(res.headers["content-type"] || "");

    if (
      status < 200 ||
      status >= 300 ||
      !contentType.includes("text/event-stream")
    ) {
      const text = await readBody(res);
      if (status === 401 || status === 403) throw authError("completion");
      try {
        const parsed = JSON.parse(text);
        if (parsed && (parsed.code === 40002 || parsed.code === 40003))
          throw authError("completion");
        const bizCode = parsed?.data?.biz_code;
        const bizMsg = parsed?.data?.biz_msg;
        const bizData = parsed?.data?.biz_data;
        if (bizCode !== undefined) {
          throw bizError(bizCode, bizMsg, bizData);
        }
      } catch (e) {
        if (e?.isAuthError || e?.isBizError) throw e;
      }
      throw new Error(
        `Completion failed: HTTP ${status}: ${text.slice(0, 1000)}`,
      );
    }

    return await streamSseFromNodeResponse(
      res,
      this.debug,
      onText,
      null,
      signal,
    );
  }
}

function authError(context) {
  const err = new Error(`Auth required during ${context}`);
  err.isAuthError = true;
  return err;
}

function bizError(code, msg, data) {
  const err = new Error(`DeepSeek biz error ${code}: ${msg}`);
  err.isBizError = true;
  err.bizCode = code;
  err.bizMsg = msg;
  err.bizData = data;
  return err;
}
