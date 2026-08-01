// @ts-check
/**
 * Settings page for the AI Free VSCode extension.
 *
 * The markup is static (index.html); this only fills it in, keeps the endpoint
 * form in sync and talks to the extension host over postMessage.
 */
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{builtIn: any[], custom: any[], models: any[], settings: Record<string, any>}} */
  let state = { builtIn: [], custom: [], models: [], settings: {} };

  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  const providers = $("providers");
  const providersEmpty = $("providers-empty");
  const endpoints = $("endpoints");
  const endpointsEmpty = $("endpoints-empty");
  const endpointActions = $("endpoint-actions");
  const listStatus = $("list-status");
  const form = $("endpoint-form");
  const formTitle = $("form-title");
  const formStatus = $("form-status");
  const keyHint = $("key-hint");
  const clearKeyRow = $("clear-key-row");

  const post = (type, payload) =>
    vscode.postMessage(Object.assign({ type }, payload || {}));

  function setStatus(node, text, ok) {
    node.textContent = text || "";
    node.classList.toggle("ok", !!text && ok);
    node.classList.toggle("err", !!text && !ok);
  }

  function busy(isBusy) {
    $("save-endpoint").disabled = isBusy;
    $("test-endpoint").disabled = isBusy;
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  function renderProviders() {
    providers.textContent = "";
    providersEmpty.hidden = state.builtIn.length > 0;

    for (const provider of state.builtIn) {
      const row = $("provider-row").content.cloneNode(true);
      row.querySelector(".name").textContent = provider.name;
      row.querySelector(".meta").textContent = provider.id;

      const badge = row.querySelector(".badge");
      badge.textContent = provider.authenticated ? "signed in" : "signed out";
      badge.classList.add(provider.authenticated ? "on" : "off");

      const button = row.querySelector(".auth");
      button.textContent = provider.authenticated ? "Sign out" : "Sign in";
      button.classList.toggle("ghost", provider.authenticated);
      button.addEventListener("click", () =>
        post(provider.authenticated ? "signOut" : "signIn", {
          id: provider.id,
        }),
      );

      providers.appendChild(row);
    }
  }

  function renderEndpoints() {
    endpoints.textContent = "";
    endpointsEmpty.hidden = state.custom.length > 0;

    for (const item of state.custom) {
      const row = $("endpoint-row").content.cloneNode(true);
      const count = item.models.length;
      row.querySelector(".name").textContent = item.config.name;
      row.querySelector(".meta").textContent = [
        item.config.baseUrl,
        count ? count + " model" + (count === 1 ? "" : "s") : "no models yet",
        item.hasKey ? "key stored" : null,
      ]
        .filter(Boolean)
        .join("  ·  ");

      const ready = item.authenticated;
      const badge = row.querySelector(".badge");
      badge.textContent =
        item.config.enabled === false
          ? "disabled"
          : ready
            ? "ready"
            : "needs key";
      badge.classList.add(ready ? "on" : "off");

      row.querySelector(".refresh").addEventListener("click", () => {
        setStatus(listStatus, "Loading models…", true);
        post("refreshModels", { id: item.config.id });
      });
      row
        .querySelector(".edit")
        .addEventListener("click", () => openForm(item));
      row.querySelector(".delete").addEventListener("click", () => {
        // The host asks for confirmation before anything is removed.
        post("deleteProvider", { id: item.config.id });
      });

      endpoints.appendChild(row);
    }
  }

  /** Fills the feature/advanced controls, and the model dropdowns. */
  function renderSettings() {
    for (const input of document.querySelectorAll("[data-setting]")) {
      const key = /** @type {any} */ (input).dataset.setting;
      const capability = /** @type {any} */ (input).dataset.capability;
      if (capability) fillModelOptions(input, capability);

      const value = state.settings[key];
      if (value === undefined) continue;
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = String(value);
    }
  }

  function fillModelOptions(select, capability) {
    const current = String(state.settings[select.dataset.setting] ?? "auto");
    select.textContent = "";
    select.appendChild(new Option("Auto (first available)", "auto"));

    let found = current === "auto";
    for (const model of state.models) {
      if (model.capabilities.indexOf(capability) === -1) continue;
      select.appendChild(
        new Option(model.family + " — " + model.name, model.id),
      );
      if (model.id === current) found = true;
    }
    // A model configured while signed in elsewhere must stay selectable.
    if (!found) {
      select.appendChild(new Option(current + " (unavailable now)", current));
    }
  }

  function render() {
    renderProviders();
    renderEndpoints();
    renderSettings();
  }

  // ── Endpoint form ─────────────────────────────────────────────────────

  /** @param {any} item existing endpoint, or undefined for a new one */
  function openForm(item) {
    const config = item ? item.config : {};
    const hasKey = !!(item && item.hasKey);

    formTitle.textContent = item ? "Edit endpoint" : "New endpoint";
    $("endpoint-id").value = config.id || "";
    $("endpoint-name").value = config.name || "";
    $("endpoint-url").value = config.baseUrl || "";
    $("endpoint-key").value = "";
    $("endpoint-key").placeholder = hasKey ? "••••••••" : "sk-...";
    keyHint.textContent = hasKey
      ? "A key is stored. Type to replace it."
      : "Stored in SecretStorage, separately from settings.";
    $("endpoint-no-key").checked = config.noApiKey === true;
    $("endpoint-clear-key").checked = false;
    clearKeyRow.hidden = !hasKey;
    $("endpoint-models").value = (config.models || [])
      .map((model) => (typeof model === "string" ? model : model.id))
      .join("\n");
    $("endpoint-max-input").value = config.maxInputTokens || 128000;
    $("endpoint-max-output").value = config.maxOutputTokens || 8192;
    $("endpoint-tools").checked = config.toolCalling !== false;
    $("endpoint-images").checked = config.imageInput === true;
    $("endpoint-thinking").checked = config.thinking === true;
    $("endpoint-enabled").checked = config.enabled !== false;
    $("endpoint-headers").value = config.headers
      ? JSON.stringify(config.headers, null, 2)
      : "";

    setStatus(formStatus, "", true);
    setStatus(listStatus, "", true);
    busy(false);
    form.hidden = false;
    endpointActions.hidden = true;
    $("endpoint-name").focus();
  }

  function closeForm() {
    form.hidden = true;
    endpointActions.hidden = false;
    setStatus(formStatus, "", true);
  }

  function readForm() {
    return {
      config: {
        id: $("endpoint-id").value,
        name: $("endpoint-name").value.trim(),
        baseUrl: $("endpoint-url").value.trim(),
        enabled: $("endpoint-enabled").checked,
        noApiKey: $("endpoint-no-key").checked,
        models: $("endpoint-models")
          .value.split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        maxInputTokens: Number($("endpoint-max-input").value) || 128000,
        maxOutputTokens: Number($("endpoint-max-output").value) || 8192,
        toolCalling: $("endpoint-tools").checked,
        imageInput: $("endpoint-images").checked,
        thinking: $("endpoint-thinking").checked,
        headers: $("endpoint-headers").value.trim(),
      },
      apiKey: $("endpoint-key").value,
      clearKey: $("endpoint-clear-key").checked,
    };
  }

  // ── Events ────────────────────────────────────────────────────────────

  $("add-endpoint").addEventListener("click", () => openForm(undefined));
  $("open-json").addEventListener("click", () => post("openJson"));
  $("cancel-endpoint").addEventListener("click", closeForm);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    busy(true);
    setStatus(formStatus, "", true);
    post("saveProvider", readForm());
  });

  $("test-endpoint").addEventListener("click", () => {
    if (!$("endpoint-url").value.trim()) {
      setStatus(formStatus, "Base URL is required.", false);
      return;
    }
    busy(true);
    setStatus(formStatus, "Connecting…", true);
    post("testProvider", readForm());
  });

  // Every plain setting is written back by its `data-setting` key.
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.addEventListener("change", () => {
      const el = /** @type {any} */ (input);
      const value =
        el.type === "checkbox"
          ? el.checked
          : el.type === "number"
            ? Number(el.value)
            : el.value;
      state.settings[el.dataset.setting] = value;
      post("setSetting", { key: el.dataset.setting, value });
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;

    if (message.type === "state") {
      state = message.payload;
      render();
      return;
    }

    if (message.type === "saved") {
      // Silent on purpose: the saved endpoint is right there in the list.
      closeForm();
      return;
    }

    if (message.type === "notice") {
      busy(false);
      if (Array.isArray(message.models) && !form.hidden) {
        $("endpoint-models").value = message.models.join("\n");
      }
      setStatus(
        form.hidden ? listStatus : formStatus,
        message.text,
        message.ok,
      );
    }
  });

  post("ready");
})();
