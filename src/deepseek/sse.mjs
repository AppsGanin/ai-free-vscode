export async function streamSseFromNodeResponse(
  res,
  debug,
  onText = null,
  timeout = 30000,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let lastAssistantMessageId = null;
  const fragments = new Map();

  // Set up timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Stream timeout exceeded"));
    }, timeout);
  });

  // Track the last activity time
  let lastActivityTime = Date.now();

  const checkTimeout = () => {
    if (Date.now() - lastActivityTime > timeout) {
      throw new Error("Stream timeout exceeded");
    }
  };

  try {
    for await (const chunk of res) {
      // Update last activity time
      lastActivityTime = Date.now();

      buffer += decoder.decode(chunk, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(rawEvent);
        if (!event.data) continue;

        if (debug)
          console.error(
            "[event]",
            event.event || "message",
            event.data.slice(0, 500),
          );

        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }

        const { text, messageId } = extractDeltaText(
          parsed,
          fragments,
          event.event,
        );
        if (messageId !== null) lastAssistantMessageId = messageId;
        if (text) {
          fullText += text;
          if (onText) await onText(text);
        }
      }

      // Check for timeout during processing
      checkTimeout();
    }
  } catch (error) {
    if (error.message === "Stream timeout exceeded") {
      throw error;
    }
    throw error;
  }

  return { lastAssistantMessageId, text: fullText };
}

export async function streamSse(res, debug, onText = null, timeout = 30000) {
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let fullText = "";
  let lastAssistantMessageId = null;
  const fragments = new Map();

  // Set up timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Stream timeout exceeded"));
    }, timeout);
  });

  try {
    for (;;) {
      // Wait for either a chunk or timeout
      const chunkPromise = reader.read();
      const result = await Promise.race([chunkPromise, timeoutPromise]);

      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(rawEvent);
        if (!event.data) continue;

        if (debug)
          console.error(
            "[event]",
            event.event || "message",
            event.data.slice(0, 500),
          );

        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }

        const { text, messageId } = extractDeltaText(
          parsed,
          fragments,
          event.event,
        );
        if (messageId !== null) lastAssistantMessageId = messageId;
        if (text) {
          fullText += text;
          if (onText) await onText(text);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { lastAssistantMessageId, text: fullText };
}

export function parseSseEvent(raw) {
  const event = { event: "", data: "" };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event.event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      event.data += (event.data ? "\n" : "") + line.slice(5).trimStart();
  }
  return event;
}

export function extractDeltaText(value, cache, eventName = "") {
  let messageId = null;
  let text = "";

  function visit(node, path) {
    if (!node || typeof node !== "object") return;

    if (typeof node.response_message_id === "number")
      messageId = node.response_message_id;
    if (typeof node.message_id === "number") messageId = node.message_id;
    if (typeof node.id === "number" && node.role === "ASSISTANT")
      messageId = node.id;

    if (
      path === "$" &&
      Object.keys(node).length === 1 &&
      typeof node.v === "string"
    ) {
      text += node.v;
      return;
    }

    if (
      node.o === "APPEND" &&
      typeof node.p === "string" &&
      node.p.endsWith("/content") &&
      typeof node.v === "string"
    ) {
      text += node.v;
      return;
    }

    if (node.o === "BATCH" && Array.isArray(node.v)) {
      node.v.forEach((item, index) => visit(item, `${path}.v.${index}`));
      return;
    }

    if (
      typeof node.content === "string" &&
      ["RESPONSE", "TEMPLATE_RESPONSE", "THINK"].includes(node.type)
    ) {
      const key = `${messageId ?? "unknown"}:${path}:${node.type}`;
      const previous = cache.get(key) || "";
      const current = node.content;
      const delta = current.startsWith(previous)
        ? current.slice(previous.length)
        : current;
      cache.set(key, current);
      text += delta;
    }

    if (typeof node?.choices?.[0]?.delta?.content === "string")
      text += node.choices[0].delta.content;

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }

    for (const [key, item] of Object.entries(node)) {
      if (key === "content" || key === "choices") continue;
      visit(item, `${path}.${key}`);
    }
  }

  visit(value, "$");
  return { text, messageId };
}
