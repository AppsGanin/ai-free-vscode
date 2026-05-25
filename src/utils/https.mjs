/**
 * Shared low-level HTTPS helpers for DeepSeek and Qwen clients.
 * Uses node:https directly to bypass VS Code's patched globalThis.fetch.
 */

import https from "node:https";
import { URL } from "node:url";

/**
 * Makes a raw HTTPS request and resolves with the IncomingMessage (stream).
 *
 * @param {string} urlStr
 * @param {string} method
 * @param {Record<string, string>} headers
 * @param {string | undefined} body  — already-serialised string body
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import("http").IncomingMessage>}
 */
export function httpsRequest(urlStr, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      method,
      headers,
    };
    let resRef = null;
    const abortErr = () => {
      const err = new Error("Request aborted");
      err.name = "AbortError";
      err.code = "ABORT_ERR";
      return err;
    };

    let req;
    const onAbort = () => {
      const err = abortErr();
      // Destroy outgoing request and incoming response stream (if already open).
      req?.destroy(err);
      if (resRef && !resRef.destroyed) {
        resRef.destroy(err);
      }
    };

    req = https.request(options, (res) => {
      resRef = res;
      // Abort might have happened between request creation and response start.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Reads all chunks from an IncomingMessage and returns the full UTF-8 body.
 *
 * @param {import("http").IncomingMessage} res
 * @returns {Promise<string>}
 */
export async function readBody(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
