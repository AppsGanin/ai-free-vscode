import { BASE_URL, BROWSER_UA } from "./config.mjs";

export function baseHeaders(token, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Accept: "*/*",
    // Explicitly request uncompressed responses — node:https does not
    // auto-decompress, so gzip would corrupt the SSE stream.
    "Accept-Encoding": "identity",
    "User-Agent": BROWSER_UA,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    "X-Platform": "pc",
    "X-Requested-With": "XMLHttpRequest",
    ...extra,
  };
}
