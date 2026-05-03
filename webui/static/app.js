(() => {
  const defaults = window.CYANRIP_DEFAULTS || {};
  const outputs = window.CYANRIP_OUTPUTS || [];
  const sanitationModes = window.CYANRIP_SANITATION || [];
  const coverSizes = window.CYANRIP_COVERART_SIZES || [];
  const initialSettings = window.CYANRIP_INITIAL_SETTINGS || {};

  const AVAILABLE_LOCALES = ["en", "de"];
  const THEME_ORDER = ["auto", "dark", "light"];

  const COOKIE_THEME = "cyanrip_theme_mode";
  const COOKIE_ANIM = "cyanrip_animations";
  const COOKIE_ADVANCED_OPEN = "cyanrip_advanced_open";
  const COOKIE_ADVANCED_HEIGHT = "cyanrip_advanced_height";
  const COOKIE_WORKSPACE = "cyanrip_workspace_mode";
  const UI_PREFS_KEY = "cyanrip_ui_prefs_v2";
  const OFFSET_PROFILE_MISC = "__misc__";

  const ADVANCED_MIN_HEIGHT = 180;
  const ADVANCED_DEFAULT_HEIGHT = 420;
  const ADVANCED_MAX_HEIGHT_RATIO = 0.74;
  const PANEL_IDS = ["ripping-panel", "output-panel", "metadata-panel"];
  const COVER_PREVIEW_RETRY_LIMIT = 4;
  const COVER_PREVIEW_RETRY_DELAY_MS = 650;

  const state = {
    previewTimer: null,
    previewRenderToken: 0,
    uiPrefsTimer: null,
    currentJobId: null,
    nextLogIndex: null,

    locale: "en",
    dictionary: {},
    fallbackDictionary: {},

    themeMode: "auto",
    animationsEnabled: true,

    settings: {
      binary_path: "./bin/cyanrip",
      working_directory: "./output",
      language: "en",
      device_profiles: {},
      misc_offset: 0,
    },

    binaryProbe: null,
    drives: [],
    selectedDriveId: "",

    session: {
      id: null,
      phase: "idle",
      scan_signature: null,
      scan_updated_at: null,
    },

    scanInProgress: false,
    runnerStatus: null,
    advancedVisible: false,
    advancedHeight: ADVANCED_DEFAULT_HEIGHT,
    activeDrawerResize: null,
    uiPrefsLoaded: false,
    workspace: {
      showAll: false,
    },
    activeLogSource: null,
    logFeedbackTimer: null,
    coverPreviewToken: 0,
    coverPreviewKey: "",
    coverRetryAfterMs: 0,
    coverRetryKey: "",

    discInfo: null,
    discOriginal: {
      album: "",
      album_artist: "",
      date: "",
      release: "",
      disc_number: null,
      total_discs: null,
    },

    trackRows: new Map(),

    ripMeta: {
      discTracks: null,
      currentTrackNo: null,
      currentTrackProgress: 0,
      eta: null,
    },

    modes: {
      offset: "manual",
      device: "auto",
      outputDir: "workdir",
      paranoia: "max",
      deemphasis: "auto",
    },

    schemeComposer: {
      activeTarget: "directory-scheme",
      partsByTarget: {},
      modeByTarget: {},
      dragging: null,
    },

    directoryPicker: {
      targetInputId: null,
      currentPath: "",
      selectedPath: "",
      homePath: "",
      projectRootPath: "",
    },
  };

  const SCHEME_TOKENS = [
    { token: "{album}", labelKey: "schemeToken.album", sample: "Album" },
    { token: "{album_artist}", labelKey: "schemeToken.albumArtist", sample: "Album artist" },
    { token: "{date}", labelKey: "schemeToken.date", sample: "2026" },
    { token: "{disc}", labelKey: "schemeToken.disc", sample: "Disc 1" },
    { token: "{track}", labelKey: "schemeToken.track", sample: "01" },
    { token: "{title}", labelKey: "schemeToken.title", sample: "Track title" },
    { token: "{artist}", labelKey: "schemeToken.artist", sample: "Track artist" },
    { token: "{format}", labelKey: "schemeToken.format", sample: "flac" },
  ];
  const SCHEME_TOKEN_SET = new Set(SCHEME_TOKENS.map((item) => item.token));
  const SCHEME_TOKEN_MAP = new Map(SCHEME_TOKENS.map((item) => [item.token, item]));
  const DISC_COVER_PLACEHOLDER =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%230a7f86'/><stop offset='100%' stop-color='%23f0a34a'/></linearGradient></defs><rect width='256' height='256' fill='url(%23g)'/><circle cx='128' cy='128' r='68' fill='rgba(255,255,255,0.32)'/><circle cx='128' cy='128' r='18' fill='rgba(17,28,39,0.65)'/></svg>",
    );
  const DISC_COVER_EMPTY = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

  const el = (id) => document.getElementById(id);

  async function initialize() {
    renderOutputCheckboxes();
    renderSelectOptions("sanitation", sanitationModes);
    renderSelectOptions("coverart-lookup-size", coverSizes.map(String));
    renderSettingsLanguageOptions();

    applyDefaults();
    loadPreferenceCookies();
    initializeBinaryToggleRows();
    initializeToggleModes();
    applyModeVisibility();
    applyAdvancedDrawerState();
    applyThemeMode();
    applyAnimationMode();

    await initI18n();
    renderSchemeTokens();
    ensureOptionHints();
    wireHintViewportBehavior();

    wireEvents();

    await loadSettings();
    await refreshDrives();
    loadUiPreferences();
    initializeBinaryToggleRows();
    initializeToggleModes();
    applyModeVisibility();
    applyOffsetForCurrentDeviceMode(false);
    updateDiscMetaDirtyIndicators();
    applyAdvancedDrawerState();
    updateToolbarButtonTitles();

    syncAllSchemeBuildersFromInputs();
    initializeSchemeModes();
    setActiveSchemeTarget(state.schemeComposer.activeTarget);
    renderDiscSummary();
    applyWorkspaceVisibility(currentWorkflowPhase().name);

    refreshPreview();
    refreshStatusAndLogs();
    window.setInterval(refreshStatusAndLogs, 1500);
  }

  function wireEvents() {
    el("theme-toggle").addEventListener("click", cycleThemeMode);
    el("animation-toggle").addEventListener("click", toggleAnimations);

    el("settings-open").addEventListener("click", openSettingsModal);
    el("settings-close").addEventListener("click", closeSettingsModal);
    el("settings-save").addEventListener("click", saveSettings);
    el("settings-probe-binary").addEventListener("click", checkBinaryFromSettings);
    el("settings-language").addEventListener("change", onSettingsLanguageChanged);
    el("settings-browse-working-directory").addEventListener("click", () => {
      openDirectoryPicker("settings-working-directory");
    });

    el("action-primary").addEventListener("click", runPrimaryDiscAction);
    el("action-stop").addEventListener("click", stopJob);
    el("action-eject").addEventListener("click", openDrive);
    el("action-back-to-scan").addEventListener("click", resetSession);
    el("workspace-toggle").addEventListener("click", toggleWorkspaceMode);
    el("action-toggle-advanced").addEventListener("click", () => toggleAdvancedPanel());
    el("advanced-close").addEventListener("click", () => toggleAdvancedPanel(false));

    el("refresh-drives").addEventListener("click", refreshDrives);
    el("device-select").addEventListener("change", onDriveChanged);
    el("browse-output-directory").addEventListener("click", () => {
      openDirectoryPicker("output-directory-manual");
    });

    el("tracks-select-all").addEventListener("change", onSelectAllTracksChanged);

    el("directory-picker-close").addEventListener("click", closeDirectoryPicker);
    el("directory-picker-cancel").addEventListener("click", closeDirectoryPicker);
    el("directory-picker-go-up").addEventListener("click", directoryPickerGoUp);
    el("directory-picker-go-home").addEventListener("click", () => {
      navigateDirectoryPicker(state.directoryPicker.homePath);
    });
    el("directory-picker-go-project").addEventListener("click", () => {
      navigateDirectoryPicker(state.directoryPicker.projectRootPath);
    });
    el("directory-picker-refresh").addEventListener("click", () => {
      navigateDirectoryPicker(state.directoryPicker.currentPath);
    });
    el("directory-picker-select").addEventListener("click", applyDirectoryPickerSelection);

    el("advanced-log-copy").addEventListener("click", copyAdvancedLog);
    el("advanced-log-download").addEventListener("click", downloadAdvancedLog);

    el("scheme-add-literal").addEventListener("click", addLiteralSchemePart);
    el("scheme-clear-active").addEventListener("click", clearActiveScheme);
    el("scheme-literal-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addLiteralSchemePart();
      }
    });

    bindModeButtons("offset", {
      auto: "offset-mode-auto",
      manual: "offset-mode-manual",
    });

    bindModeButtons("device", {
      auto: "device-mode-auto",
      select: "device-mode-select",
      path: "device-mode-path",
    });

    bindModeButtons("outputDir", {
      workdir: "output-dir-mode-workdir",
      manual: "output-dir-mode-manual",
    });

    bindModeButtons("paranoia", {
      max: "paranoia-mode-max",
      numeric: "paranoia-mode-numeric",
      none: "paranoia-mode-none",
    });

    bindModeButtons("deemphasis", {
      auto: "deemphasis-mode-auto",
      force: "deemphasis-mode-force",
      disable: "deemphasis-mode-disable",
    });

    el("offset").addEventListener("change", persistOffsetProfileIfNeeded);
    el("offset").addEventListener("input", saveUiPreferencesDebounced);
    el("paranoia-value").addEventListener("input", debouncePreview);
    el("paranoia-value").addEventListener("change", saveUiPreferencesDebounced);
    el("output-directory-manual").addEventListener("input", debouncePreview);
    el("settings-binary-path").addEventListener("change", saveUiPreferencesDebounced);
    el("settings-working-directory").addEventListener("change", saveUiPreferencesDebounced);
    el("settings-language").addEventListener("change", saveUiPreferencesDebounced);

    document.querySelectorAll("input,select,textarea").forEach((node) => {
      node.addEventListener("input", debouncePreview);
      node.addEventListener("change", debouncePreview);
      node.addEventListener("change", saveUiPreferencesDebounced);
    });

    document.querySelectorAll(".binary-toggle").forEach((node) => {
      const targetId = String(node.dataset.binaryToggle || "").trim();
      const target = el(targetId);
      if (!target) {
        return;
      }
      node.querySelectorAll(".toggle-option").forEach((btn) => {
        btn.addEventListener("click", () => {
          const value = String(btn.dataset.value || "");
          const checked = value === "on";
          target.checked = checked;
          refreshBinaryToggleRow(node, target.checked);
          debouncePreview();
          saveUiPreferencesDebounced();
          if (targetId === "enable-coverart-db") {
            renderDiscSummary();
          }
        });
      });
      target.addEventListener("change", () => refreshBinaryToggleRow(node, target.checked));
    });

    document.querySelectorAll(".scheme-group input").forEach((node) => {
      node.addEventListener("focus", () => {
        setActiveSchemeTarget(node.id);
      });
      node.addEventListener("input", () => {
        state.schemeComposer.partsByTarget[node.id] = parseSchemeParts(node.value);
        renderActiveSchemeComposer();
        saveUiPreferencesDebounced();
      });
    });

    document.querySelectorAll(".scheme-target").forEach((node) => {
      node.addEventListener("click", () => {
        const target = node.dataset.target;
        if (target) {
          setActiveSchemeTarget(target);
          saveUiPreferencesDebounced();
        }
      });
    });

    document.querySelectorAll(".toggle-row[data-group='scheme-mode'] .toggle-option").forEach((node) => {
      node.addEventListener("click", () => {
        const targetId = state.schemeComposer.activeTarget || "directory-scheme";
        const mode = String(node.dataset.value || "");
        if (!["auto", "manual"].includes(mode)) {
          return;
        }
        setSchemeModeForTarget(targetId, mode);
      });
    });

    const dropzone = el("scheme-dropzone");
    dropzone.addEventListener("dragover", onSchemeDropzoneDragOver);
    dropzone.addEventListener("dragleave", onSchemeDropzoneDragLeave);
    dropzone.addEventListener("drop", onSchemeDropzoneDrop);

    initAdvancedDrawerResize();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (state.themeMode === "auto") {
        updateToolbarButtonTitles();
      }
    });

    el("settings-overlay").addEventListener("click", (event) => {
      if (event.target === el("settings-overlay")) {
        closeSettingsModal();
      }
    });

    el("directory-picker-overlay").addEventListener("click", (event) => {
      if (event.target === el("directory-picker-overlay")) {
        closeDirectoryPicker();
      }
    });

    ["disc-album", "disc-artist", "disc-date", "release", "disc-number", "total-discs"].forEach((id) => {
      const node = el(id);
      if (!node) {
        return;
      }
      node.addEventListener("input", updateDiscMetaDirtyIndicators);
      node.addEventListener("change", updateDiscMetaDirtyIndicators);
    });

    el("enable-coverart-db").addEventListener("change", renderDiscSummary);
  }

  function bindModeButtons(modeKey, buttonMap) {
    Object.entries(buttonMap).forEach(([mode, id]) => {
      const node = el(id);
      node.addEventListener("click", () => {
        setToggleMode(modeKey, mode);
        applyModeVisibility();
        debouncePreview();
        saveUiPreferencesDebounced();

        if (modeKey === "offset") {
          persistOffsetProfileIfNeeded();
        }
        if (modeKey === "device") {
          if (mode === "select") {
            state.selectedDriveId = el("device-select").value || state.selectedDriveId;
          }
          applyOffsetForCurrentDeviceMode(false);
        }
      });
    });
  }

  function setToggleMode(modeKey, mode) {
    state.modes[modeKey] = mode;

    const candidates = document.querySelectorAll(`.toggle-row[data-group='${modeKey}-mode'] .toggle-option`);
    candidates.forEach((node) => {
      const value = node.dataset.value;
      node.classList.toggle("is-active", value === mode);
    });
  }

  function initializeBinaryToggleRows() {
    document.querySelectorAll(".binary-toggle").forEach((node) => {
      const targetId = String(node.dataset.binaryToggle || "").trim();
      const target = el(targetId);
      if (!target) {
        return;
      }
      refreshBinaryToggleRow(node, !!target.checked);
    });
  }

  function refreshBinaryToggleRow(rowNode, enabled) {
    rowNode.querySelectorAll(".toggle-option").forEach((btn) => {
      const value = String(btn.dataset.value || "");
      btn.classList.toggle("is-active", (enabled && value === "on") || (!enabled && value === "off"));
    });
  }

  function applyModeVisibility() {
    const offsetManual = state.modes.offset === "manual";
    el("offset").disabled = !offsetManual;
    el("offset-manual-row").classList.toggle("is-hidden", !offsetManual);

    const deviceSelectRow = el("device-select").parentElement;
    const devicePathInput = el("device-path");
    const selectVisible = state.modes.device === "select";
    const pathVisible = state.modes.device === "path";

    deviceSelectRow.classList.toggle("is-hidden", !selectVisible);
    devicePathInput.classList.toggle("is-hidden", !pathVisible);
    devicePathInput.disabled = !pathVisible;

    const manualOutput = state.modes.outputDir === "manual";
    el("output-directory-manual").disabled = !manualOutput;
    el("browse-output-directory").disabled = !manualOutput;
    el("output-directory-manual-row").classList.toggle("is-hidden", !manualOutput);

    const paranoiaNumeric = state.modes.paranoia === "numeric";
    el("paranoia-numeric-row").classList.toggle("is-hidden", !paranoiaNumeric);
    el("paranoia-value").disabled = !paranoiaNumeric;

    const activeSchemeTarget = state.schemeComposer.activeTarget || "directory-scheme";
    const activeSchemeMode = normalizeSchemeMode(state.schemeComposer.modeByTarget[activeSchemeTarget]);
    el("scheme-composer-area").classList.toggle("is-hidden", activeSchemeMode !== "manual");
  }

  function initializeToggleModes() {
    setToggleMode("offset", state.modes.offset || "manual");
    setToggleMode("device", state.modes.device || "auto");
    setToggleMode("outputDir", state.modes.outputDir || "workdir");
    setToggleMode("paranoia", state.modes.paranoia || "max");
    setToggleMode("deemphasis", state.modes.deemphasis || "auto");
  }

  async function loadSettings() {
    clearError();

    try {
      const response = await apiGet("/api/settings");
      const settings = response.settings || {};
      const binary = response.binary || null;

      applySettings(settings);
      state.binaryProbe = binary;
      renderBinaryStatus();
    } catch (error) {
      showError(error.message);
      applySettings(initialSettings || {});
    }
  }

  function applySettings(settings) {
    const merged = {
      binary_path: "./bin/cyanrip",
      working_directory: "./output",
      language: "en",
      device_profiles: {},
      misc_offset: 0,
      ...settings,
    };

    state.settings = merged;

    el("settings-binary-path").value = merged.binary_path || "";
    el("settings-working-directory").value = merged.working_directory || "./output";
    el("settings-language").value = normalizeLocale(merged.language) || "en";

    if (merged.language && normalizeLocale(merged.language) !== state.locale) {
      setLocale(normalizeLocale(merged.language) || "en").then(() => {
        applyTranslations();
        updateToolbarButtonTitles();
        updateStatusPanel();
      });
    }

    if (state.modes.device !== "select" && state.modes.offset === "manual") {
      applyOffsetForCurrentDeviceMode(false);
    }
  }

  async function saveSettings() {
    clearError();

    const payload = {
      settings: {
        binary_path: el("settings-binary-path").value.trim(),
        working_directory: el("settings-working-directory").value.trim(),
        language: normalizeLocale(el("settings-language").value) || "en",
      },
    };

    try {
      const response = await apiPost("/api/settings", payload);
      applySettings(response.settings || {});
      state.binaryProbe = response.binary || null;
      renderBinaryStatus();
      closeSettingsModal();
      setMessage("action-message", t("message.settingsSaved"));

      await setLocale(payload.settings.language);
      applyTranslations();
      updateToolbarButtonTitles();
      refreshAllTrackLabels();
      updateStatusPanel();
      refreshPreview();
    } catch (error) {
      showError(error.message);
    }
  }

  async function checkBinaryFromSettings() {
    clearError();

    try {
      const probe = await apiPost("/api/probe", {
        binary_path: el("settings-binary-path").value.trim(),
      });
      state.binaryProbe = probe;
      renderBinaryStatus();
    } catch (error) {
      showError(error.message);
    }
  }

  function renderBinaryStatus() {
    const node = el("settings-binary-status");
    const probe = state.binaryProbe;
    if (!probe) {
      node.textContent = t("settings.binaryUnknown");
      return;
    }

    if (probe.ok) {
      node.textContent = [
        t("settings.binaryOk"),
        `${t("settings.binaryPath")}: ${probe.binary_path || "-"}`,
        `${t("settings.binaryVersion")}: ${probe.version || "-"}`,
      ].join("\n");
      return;
    }

    node.textContent = [
      t("settings.binaryMissing"),
      `${t("settings.binaryPath")}: ${probe.binary_path || "-"}`,
      `${t("settings.binaryError")}: ${probe.error || "-"}`,
    ].join("\n");
  }

  async function openDirectoryPicker(targetInputId) {
    const input = el(targetInputId);
    if (!input) {
      return;
    }

    const rawPath = String(input.value || "").trim();

    state.directoryPicker.targetInputId = targetInputId;
    state.directoryPicker.currentPath = rawPath || state.settings.working_directory || "./output";
    state.directoryPicker.selectedPath = state.directoryPicker.currentPath;

    const overlay = el("directory-picker-overlay");
    overlay.classList.remove("is-hidden");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    await navigateDirectoryPicker(state.directoryPicker.currentPath);
  }

  function closeDirectoryPicker() {
    const overlay = el("directory-picker-overlay");
    overlay.classList.add("is-hidden");
    overlay.setAttribute("aria-hidden", "true");
    if (el("settings-overlay").classList.contains("is-hidden")) {
      document.body.classList.remove("modal-open");
    }
  }

  async function directoryPickerGoUp() {
    const currentPath = String(state.directoryPicker.currentPath || "");
    if (!currentPath) {
      return;
    }
    try {
      const response = await apiGet(`/api/fs/directories?path=${encodeURIComponent(currentPath)}`);
      if (response.parent) {
        await navigateDirectoryPicker(response.parent);
      }
    } catch (error) {
      showError(error.message);
    }
  }

  async function navigateDirectoryPicker(path) {
    clearError();
    const requested = String(path || "").trim();

    try {
      const response = await apiGet(`/api/fs/directories?path=${encodeURIComponent(requested)}`);
      state.directoryPicker.currentPath = response.path || requested;
      state.directoryPicker.selectedPath = response.path || requested;
      state.directoryPicker.homePath = response.home || state.directoryPicker.homePath;
      state.directoryPicker.projectRootPath = response.project_root || state.directoryPicker.projectRootPath;
      renderDirectoryPicker(response);
    } catch (error) {
      showError(error.message);
    }
  }

  function renderDirectoryPicker(payload) {
    const currentPath = String(payload.path || "");
    const list = Array.isArray(payload.directories) ? payload.directories : [];

    el("directory-picker-current-path").textContent = currentPath;
    el("directory-picker-current-path").title = currentPath;

    const container = el("directory-picker-list");
    container.innerHTML = "";

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "directory-picker-empty";
      empty.textContent = t("directoryPicker.empty");
      container.appendChild(empty);
      return;
    }

    list.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "directory-picker-entry";
      button.dataset.path = entry.path;

      const name = document.createElement("span");
      name.className = "directory-picker-entry-name";
      name.textContent = entry.name || entry.path;

      const path = document.createElement("span");
      path.className = "directory-picker-entry-path";
      path.textContent = entry.path;
      path.title = entry.path;

      button.append(name, path);
      button.addEventListener("click", () => {
        state.directoryPicker.selectedPath = entry.path;
        updateDirectoryPickerSelection();
      });
      button.addEventListener("dblclick", async () => {
        await navigateDirectoryPicker(entry.path);
      });

      container.appendChild(button);
    });

    updateDirectoryPickerSelection();
  }

  function updateDirectoryPickerSelection() {
    const selected = String(state.directoryPicker.selectedPath || state.directoryPicker.currentPath || "");
    el("directory-picker-list").querySelectorAll(".directory-picker-entry").forEach((node) => {
      node.classList.toggle("is-selected", node.dataset.path === selected);
    });
  }

  function applyDirectoryPickerSelection() {
    const targetId = state.directoryPicker.targetInputId;
    if (!targetId) {
      closeDirectoryPicker();
      return;
    }

    const chosen = String(state.directoryPicker.selectedPath || state.directoryPicker.currentPath || "").trim();
    const target = el(targetId);
    if (target && chosen) {
      target.value = chosen;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    closeDirectoryPicker();
  }

  async function refreshDrives() {
    try {
      const response = await apiGet("/api/drives");
      state.drives = Array.isArray(response.drives) ? response.drives : [];
      renderDrives();
      applyOffsetForCurrentDeviceMode(false);
      saveUiPreferencesDebounced();
    } catch (error) {
      showError(error.message);
    }
  }

  function renderDrives() {
    const select = el("device-select");
    const previousValue = state.selectedDriveId || select.value;

    select.innerHTML = "";

    state.drives.forEach((drive) => {
      const option = document.createElement("option");
      option.value = drive.id;

      const offsetText = drive.saved_offset === null || drive.saved_offset === undefined
        ? ""
        : ` | offset ${drive.saved_offset}`;

      option.textContent = `${drive.label || drive.name || drive.id} (${drive.path})${offsetText}`;
      select.appendChild(option);
    });

    if (state.drives.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("drive.noneFound");
      select.appendChild(option);
    }

    if (previousValue && Array.from(select.options).some((item) => item.value === previousValue)) {
      select.value = previousValue;
    }

    state.selectedDriveId = select.value || "";
  }

  async function onDriveChanged() {
    state.selectedDriveId = el("device-select").value || "";
    applyOffsetForCurrentDeviceMode(false);
    saveUiPreferencesDebounced();
    debouncePreview();
  }

  function applyOffsetForCurrentDeviceMode(forceManual) {
    if (state.modes.device === "select") {
      const drive = state.drives.find((item) => item.id === state.selectedDriveId);
      if (!drive || drive.saved_offset === null || drive.saved_offset === undefined) {
        return;
      }
      el("offset").value = String(drive.saved_offset);
      if (forceManual && state.modes.offset !== "manual") {
        setToggleMode("offset", "manual");
        applyModeVisibility();
      }
      debouncePreview();
      return;
    }

    const miscOffset = normalizeOptionalInt(state.settings.misc_offset);
    if (miscOffset === null) {
      return;
    }
    el("offset").value = String(miscOffset);
    if (forceManual && state.modes.offset !== "manual") {
      setToggleMode("offset", "manual");
      applyModeVisibility();
    }
    debouncePreview();
  }

  async function persistOffsetProfileIfNeeded() {
    if (state.modes.offset !== "manual") {
      return;
    }

    let offsetValue = null;
    try {
      offsetValue = intOrNull(el("offset").value);
    } catch (_) {
      return;
    }
    if (offsetValue === null) {
      return;
    }

    const deviceId = state.modes.device === "select" ? (el("device-select").value || "") : OFFSET_PROFILE_MISC;
    if (!deviceId) {
      return;
    }

    try {
      const response = await apiPost("/api/drives/offset", {
        device_id: deviceId,
        offset: offsetValue,
      });
      if (Array.isArray(response.drives)) {
        state.drives = response.drives;
      } else {
        const index = state.drives.findIndex((item) => item.id === deviceId);
        if (index >= 0 && deviceId !== OFFSET_PROFILE_MISC) {
          state.drives[index] = { ...state.drives[index], saved_offset: offsetValue };
        }
      }
      if (response.settings && typeof response.settings === "object") {
        state.settings = { ...state.settings, ...response.settings };
      } else if (deviceId === OFFSET_PROFILE_MISC) {
        state.settings.misc_offset = offsetValue;
      }
      renderDrives();
      if (deviceId !== OFFSET_PROFILE_MISC) {
        state.selectedDriveId = deviceId;
        el("device-select").value = deviceId;
      }
      saveUiPreferencesDebounced();
    } catch (_) {
      // Persistence is best-effort for UI convenience.
    }
  }

  async function resetSession() {
    clearError();

    try {
      const status = await apiPost("/api/session/reset", {});
      applyStatusSnapshot(status);
      clearTrackTable();
      clearDiscMeta();
      el("job-log").textContent = "";
      state.nextLogIndex = null;
      state.activeLogSource = null;
      state.scanInProgress = false;
      updateDiscMetaDirtyIndicators();
      setMessage("action-message", t("message.backToScan"));
      refreshPreview();
    } catch (error) {
      showError(error.message);
    }
  }

  async function runPrimaryDiscAction() {
    const workflow = currentWorkflowPhase();
    if (workflow.name === "post_scan") {
      await startJob();
      return;
    }
    await scanDisc();
  }

  async function scanDisc() {
    clearError();
    state.scanInProgress = true;
    updateStatusPanel();

    try {
      const payload = {
        binary_path: state.settings.binary_path,
        working_directory: state.settings.working_directory,
        config: collectConfig(),
      };

      const result = await apiPost("/api/scan", payload);
      applySessionSnapshot(result.session || null);
      applyDiscSnapshot(result.disc || {}, Array.isArray(result.tracks) ? result.tracks : []);
      updateDiscMetaDirtyIndicators();
      setMessage("action-message", t("message.scanDone"));
    } catch (error) {
      const message = String((error && error.message) || "");
      if (message.toLowerCase().includes("abgebrochen") || message.toLowerCase().includes("cancel")) {
        clearError();
        setMessage("action-message", t("message.scanStopped"));
      } else {
        showError(error.message);
        setMessage("action-message", "");
      }
    } finally {
      state.scanInProgress = false;
      updateStatusPanel();
      refreshPreview();
    }
  }

  async function startJob() {
    clearError();
    if (currentWorkflowPhase().name !== "post_scan") {
      showError(t("error.scanRequired"));
      return;
    }

    const payload = {
      binary_path: state.settings.binary_path,
      working_directory: effectiveWorkingDirectoryForRip(),
      config: collectConfig(),
    };

    try {
      const snapshot = await apiPost("/api/start", payload);
      applyStatusSnapshot(snapshot);
      setMessage("action-message", t("message.ripStarted"));
      await refreshStatusAndLogs();
    } catch (error) {
      showError(error.message);
      setMessage("action-message", "");
    }
  }

  async function stopJob() {
    clearError();
    const wasScanning = !!state.scanInProgress;
    const wasRipping = !!(state.runnerStatus && state.runnerStatus.is_running);

    try {
      const snapshot = await apiPost("/api/stop", {});
      applyStatusSnapshot(snapshot);
      state.scanInProgress = false;
      if (wasScanning) {
        setMessage("action-message", t("message.scanStopped"));
      } else if (wasRipping) {
        setMessage("action-message", t("message.ripStopped"));
      } else {
        setMessage("action-message", "");
      }
    } catch (error) {
      showError(error.message);
    }
  }

  async function openDrive() {
    clearError();

    const devicePath = resolveDevicePathForEject();
    if (devicePath === null) {
      showError(t("error.ejectAutoAmbiguous"));
      return;
    }

    try {
      const result = await apiPost("/api/eject", { device_path: devicePath });
      const lines = [];
      lines.push(result.message || t("message.ejectDone"));
      if (result.output_preview) {
        lines.push(result.output_preview);
      }
      setMessage("action-message", lines.filter(Boolean).join("\n"));
    } catch (error) {
      showError(error.message);
      setMessage("action-message", "");
    }
  }

  function resolveDevicePathForEject() {
    if (state.modes.device === "path") {
      const manual = el("device-path").value.trim();
      return manual || null;
    }

    if (state.modes.device === "select") {
      const drive = state.drives.find((item) => item.id === el("device-select").value);
      return drive ? String(drive.path || "").trim() : null;
    }

    if (state.drives.length === 1) {
      return String(state.drives[0].path || "").trim();
    }
    return null;
  }

  function resolveDevicePathForCommand() {
    if (state.modes.device === "path") {
      return el("device-path").value.trim();
    }

    if (state.modes.device === "select") {
      const drive = state.drives.find((item) => item.id === el("device-select").value);
      return drive ? String(drive.path || "").trim() : "";
    }

    return "";
  }

  async function refreshStatusAndLogs() {
    try {
      const status = await apiGet("/api/status");
      applyStatusSnapshot(status);

      const source = String(status.log_source || "rip");
      if (state.activeLogSource !== source) {
        state.activeLogSource = source;
        state.nextLogIndex = null;
        el("job-log").textContent = "";
      }

      if (status.log_oldest_index !== undefined && status.log_oldest_index !== null) {
        if (state.nextLogIndex === null) {
          state.nextLogIndex = status.log_oldest_index;
        }
      }

      const since = state.nextLogIndex ?? 0;
      const logs = await apiGet(
        `/api/logs?source=${encodeURIComponent(source)}&since=${encodeURIComponent(String(since))}`,
      );
      appendLogs(logs.lines || []);
      state.nextLogIndex = logs.next_index;

      updateStatusPanel();
    } catch (error) {
      showError(error.message);
    }
  }

  function applyStatusSnapshot(status) {
    state.runnerStatus = status;
    const phaseRaw = String((status && status.session && status.session.phase) || "");
    state.scanInProgress = phaseRaw === "scanning" ? true : state.scanInProgress;

    if (status.job_id !== state.currentJobId) {
      state.currentJobId = status.job_id;
      state.nextLogIndex = null;
      state.ripMeta.currentTrackNo = null;
      state.ripMeta.currentTrackProgress = 0;
      state.ripMeta.eta = null;
      el("job-log").textContent = "";
    }

    applySessionSnapshot(status.session || null);

    const scan = status && typeof status.scan === "object" ? status.scan : {};
    const disc = status && typeof status.disc === "object" ? status.disc : {};
    const rip = status && typeof status.rip === "object" ? status.rip : {};

    if (disc && typeof disc.info === "object" && Object.keys(disc.info).length > 0) {
      state.discInfo = disc.info;
      hydrateDiscMetaFromDiscInfo();
    }

    if (Array.isArray(disc.tracks) && disc.tracks.length > 0 && state.trackRows.size === 0) {
      applyDiscSnapshot(state.discInfo || {}, disc.tracks);
    }

    if (Array.isArray(rip.tracks) && rip.tracks.length > 0) {
      applyRipTracksSnapshot(rip.tracks);
    }

    state.ripMeta.discTracks = normalizeOptionalInt(rip.disc_tracks);
    state.ripMeta.currentTrackNo = normalizeOptionalInt(rip.current_track_no);

    const currentProgress = Number.parseFloat(String(rip.current_track_progress));
    if (!Number.isNaN(currentProgress)) {
      state.ripMeta.currentTrackProgress = clamp(currentProgress, 0, 100);
    }

    if (typeof rip.eta === "string" && rip.eta.trim()) {
      state.ripMeta.eta = rip.eta.trim();
    } else {
      state.ripMeta.eta = null;
    }

    if (scan.last_success && state.trackRows.size > 0 && state.session.phase === "idle") {
      state.session.phase = "scanned";
    }

    if (phaseRaw && phaseRaw !== "scanning") {
      state.scanInProgress = false;
    }
  }

  function applySessionSnapshot(session) {
    if (!session || typeof session !== "object") {
      return;
    }

    const incomingId = session.id || null;
    if (incomingId && state.session.id && incomingId !== state.session.id) {
      clearTrackTable();
      clearDiscMeta();
      el("job-log").textContent = "";
      state.nextLogIndex = null;
      state.activeLogSource = null;
      state.currentJobId = null;
    }

    state.session = {
      id: incomingId,
      phase: session.phase || "idle",
      scan_signature: session.scan_signature || null,
      scan_updated_at: session.scan_updated_at || null,
    };
  }

  function applyDiscSnapshot(disc, tracks) {
    state.discInfo = disc;
    hydrateDiscMetaFromDiscInfo(false);

    state.trackRows.clear();
    state.ripMeta.currentTrackNo = null;

    el("tracks-body").innerHTML = "";

    tracks.forEach((track) => {
      upsertTrackRow(track.number, {
        title: track.title || `Track ${String(track.number).padStart(2, "0")}`,
        artist: track.artist || "",
        duration: track.duration || "",
        status: "detected",
        progress: Number(track.progress || 0),
        accuripText: track.accurip_text || track.accurip || "",
        accuripConfidence: normalizeOptionalInt(track.accurip_confidence),
        accuripMaxConfidence: normalizeOptionalInt(track.accurip_max_confidence),
      });
    });

    el("tracks-empty").style.display = tracks.length > 0 ? "none" : "block";
    renderDiscSummary();
    updateSelectAllState();
  }

  function hydrateDiscMetaFromDiscInfo(preserveDirty = true) {
    const info = state.discInfo || {};

    const album = String(info.album || "").trim();
    const artist = String(info.album_artist || "").trim();
    const date = String(info.date || "").trim();
    const release = String(info.release || info.release_id || "").trim();
    const discNumber = normalizeOptionalInt(info.disc_number);
    const totalDiscs = normalizeOptionalInt(info.total_discs);

    state.discOriginal = {
      album,
      album_artist: artist,
      date,
      release,
      disc_number: discNumber,
      total_discs: totalDiscs,
    };

    setDiscInputValue("disc-album", album, preserveDirty);
    setDiscInputValue("disc-artist", artist, preserveDirty);
    setDiscInputValue("disc-date", date, preserveDirty);
    setDiscInputValue("release", release, preserveDirty);
    setDiscInputValue("disc-number", valueOrEmpty(discNumber), preserveDirty);
    setDiscInputValue("total-discs", valueOrEmpty(totalDiscs), preserveDirty);
    updateDiscMetaDirtyIndicators();
  }

  function setDiscInputValue(id, value, preserveDirty) {
    const node = el(id);
    const isDirty = node.classList.contains("is-dirty");
    if (preserveDirty && isDirty) {
      return;
    }
    node.value = value || "";
    node.classList.remove("is-dirty");
  }

  function clearDiscMeta() {
    state.discInfo = null;
    state.discOriginal = {
      album: "",
      album_artist: "",
      date: "",
      release: "",
      disc_number: null,
      total_discs: null,
    };
    setDiscInputValue("disc-album", "", false);
    setDiscInputValue("disc-artist", "", false);
    setDiscInputValue("disc-date", "", false);
    setDiscInputValue("release", "", false);
    setDiscInputValue("disc-number", "", false);
    setDiscInputValue("total-discs", "", false);
    updateDiscMetaDirtyIndicators();
    setMessage("scan-summary", "");
    renderDiscCoverPreview();
  }

  function renderDiscSummary() {
    renderDiscCoverPreview();

    if (!state.discInfo && state.trackRows.size === 0) {
      setMessage("scan-summary", "");
      return;
    }

    const disc = state.discInfo || {};
    const tracksCount = state.trackRows.size || Number.parseInt(String(disc.disc_tracks || "0"), 10) || 0;

    const lines = [];
    lines.push(`${t("disc.summary.album")}: ${disc.album || t("disc.unknownAlbum")}`);
    lines.push(`${t("disc.summary.artist")}: ${disc.album_artist || t("disc.unknownArtist")}`);
    lines.push(`${t("disc.summary.tracks")}: ${tracksCount}`);
    lines.push(`${t("disc.summary.totalTime")}: ${disc.total_time || "-"}`);

    let accurateripSummary = String(disc.accuraterip || "").trim();
    const maxConfidence = findDiscMaxAccuripConfidence();
    if (!accurateripSummary) {
      accurateripSummary = "-";
    }
    if (maxConfidence !== null) {
      accurateripSummary = `${accurateripSummary} (${t("disc.summary.maxConfidence", { value: maxConfidence })})`;
    }
    lines.push(`${t("disc.summary.accuraterip")}: ${accurateripSummary}`);

    setMessage("scan-summary", lines.join("\n"));
  }

  function renderDiscCoverPreview() {
    const coverWrap = el("disc-cover-wrap");
    const cover = el("disc-cover-preview");
    const spinner = el("disc-cover-spinner");
    const source = resolveDiscCoverSource();
    const sourceKey = `${source.kind}:${source.url || ""}`;
    const now = Date.now();

    if (
      source.kind !== "empty" &&
      source.kind !== "placeholder" &&
      now < state.coverRetryAfterMs &&
      sourceKey === state.coverRetryKey
    ) {
      return;
    }

    if (state.coverPreviewKey === sourceKey) {
      return;
    }
    state.coverPreviewKey = sourceKey;

    state.coverPreviewToken += 1;
    const token = state.coverPreviewToken;

    if (source.kind === "empty") {
      coverWrap.classList.add("is-empty");
      coverWrap.classList.remove("is-loading");
      spinner.classList.add("is-hidden");
      cover.src = DISC_COVER_EMPTY;
      return;
    }

    if (source.kind === "placeholder") {
      coverWrap.classList.remove("is-empty");
      coverWrap.classList.remove("is-loading");
      spinner.classList.add("is-hidden");
      cover.src = DISC_COVER_PLACEHOLDER;
      return;
    }

    coverWrap.classList.remove("is-empty");
    coverWrap.classList.add("is-loading");
    spinner.classList.remove("is-hidden");
    state.coverRetryAfterMs = 0;
    loadDiscCoverWithRetry({
      sourceUrl: source.url,
      sourceKey,
      token,
      attempt: 1,
    });
  }

  function loadDiscCoverWithRetry({ sourceUrl, sourceKey, token, attempt }) {
    const previewUrl = withCoverAttemptQuery(sourceUrl, attempt);
    const probe = new Image();

    probe.onload = () => {
      if (token !== state.coverPreviewToken) {
        return;
      }
      const coverWrap = el("disc-cover-wrap");
      const cover = el("disc-cover-preview");
      const spinner = el("disc-cover-spinner");
      cover.src = previewUrl;
      coverWrap.classList.remove("is-loading");
      spinner.classList.add("is-hidden");
      state.coverRetryKey = "";
    };

    probe.onerror = () => {
      if (token !== state.coverPreviewToken) {
        return;
      }
      if (attempt < COVER_PREVIEW_RETRY_LIMIT) {
        window.setTimeout(
          () => loadDiscCoverWithRetry({ sourceUrl, sourceKey, token, attempt: attempt + 1 }),
          COVER_PREVIEW_RETRY_DELAY_MS * attempt,
        );
        return;
      }

      const coverWrap = el("disc-cover-wrap");
      const cover = el("disc-cover-preview");
      const spinner = el("disc-cover-spinner");
      cover.src = DISC_COVER_PLACEHOLDER;
      coverWrap.classList.remove("is-loading");
      spinner.classList.add("is-hidden");
      state.coverPreviewKey = "";
      state.coverRetryAfterMs = Date.now() + 8000;
      state.coverRetryKey = sourceKey;
    };

    probe.src = previewUrl;
  }

  function withCoverAttemptQuery(url, attempt) {
    if (url.startsWith("data:")) {
      return url;
    }
    const glue = url.includes("?") ? "&" : "?";
    return `${url}${glue}try=${Date.now()}-${attempt}`;
  }

  function resolveDiscCoverSource() {
    if (!state.discInfo && state.trackRows.size === 0) {
      return { kind: "empty" };
    }

    if (!el("enable-coverart-db").checked) {
      return { kind: "placeholder" };
    }

    const disc = state.discInfo || {};
    const raw = String(disc.album_art || disc.cover_art || "").trim();
    const candidate = resolveCoverSourceCandidate(raw, disc);
    if (!candidate) {
      return { kind: "placeholder" };
    }

    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
      return { kind: "remote", url: `/api/cover?url=${encodeURIComponent(candidate)}` };
    }

    if (candidate.startsWith("data:image/")) {
      return { kind: "inline", url: candidate };
    }

    return { kind: "local", url: `/api/cover?path=${encodeURIComponent(candidate)}` };
  }

  function resolveCoverSourceCandidate(raw, disc) {
    const source = String(raw || "").trim();
    if (source) {
      const matches = source.match(/https?:\/\/[^\s]+/gi) || [];
      const normalizedUrl = matches
        .map((item) => item.replace(/[),.;]+$/, "").trim())
        .find((item) => item.startsWith("http://") || item.startsWith("https://"));
      if (normalizedUrl) {
        return normalizedUrl;
      }

      const entries = source.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
      for (const entry of entries) {
        const rawCandidate = entry.includes("=") ? entry.split("=").slice(1).join("=").trim() : entry;
        if (!rawCandidate) {
          continue;
        }
        if (rawCandidate.startsWith("data:image/")) {
          return rawCandidate;
        }
        if (rawCandidate.startsWith("http://") || rawCandidate.startsWith("https://")) {
          return rawCandidate;
        }
        if (isLikelyLocalCoverPath(rawCandidate)) {
          return rawCandidate;
        }
      }
    }

    const releaseId = String(disc.release_id || disc.release || "").trim();
    if (releaseId && /^[A-Za-z0-9-]{8,}$/.test(releaseId)) {
      return `https://coverartarchive.org/release/${encodeURIComponent(releaseId)}/front`;
    }

    return "";
  }

  function isLikelyLocalCoverPath(value) {
    const text = String(value || "").trim();
    if (!text) {
      return false;
    }
    return (
      text.startsWith("/") ||
      text.startsWith("./") ||
      text.startsWith("../") ||
      text.startsWith("~/") ||
      /^[A-Za-z]:[\\/]/.test(text)
    );
  }

  function findDiscMaxAccuripConfidence() {
    let maxConfidence = null;
    state.trackRows.forEach((row) => {
      const candidate = normalizeOptionalInt(row.accuripMaxConfidence);
      if (candidate === null) {
        return;
      }
      if (maxConfidence === null || candidate > maxConfidence) {
        maxConfidence = candidate;
      }
    });
    return maxConfidence;
  }

  function clearTrackTable() {
    state.trackRows.clear();
    el("tracks-body").innerHTML = "";
    el("tracks-empty").style.display = "block";
    updateSelectAllState();
  }

  function applyRipTracksSnapshot(tracks) {
    tracks.forEach((track) => {
      const trackNo = normalizeOptionalInt(track.number);
      if (trackNo === null || trackNo <= 0) {
        return;
      }

      upsertTrackRow(trackNo, {
        title: track.title || `Track ${String(trackNo).padStart(2, "0")}`,
        artist: track.artist || "",
        duration: track.duration || "",
        status: track.status || "detected",
        progress: Number(track.progress || 0),
        accuripText: track.accurip_text || track.accurip || "",
        accuripConfidence: normalizeOptionalInt(track.accurip_confidence),
        accuripMaxConfidence: normalizeOptionalInt(track.accurip_max_confidence),
      });
    });

    if (state.trackRows.size > 0) {
      el("tracks-empty").style.display = "none";
    }
  }

  function upsertTrackRow(trackNo, patch) {
    const number = Number.parseInt(String(trackNo), 10);
    if (Number.isNaN(number) || number <= 0) {
      return;
    }

    let row = state.trackRows.get(number);
    if (!row) {
      row = createTrackRow(number);
      state.trackRows.set(number, row);
      el("tracks-empty").style.display = "none";
    }

    const title = patch.title ?? row.originalTitle;
    const artist = patch.artist ?? row.originalArtist;
    const duration = patch.duration ?? row.durationCell.textContent;
    const status = patch.status ?? row.statusValue;
    const progress = patch.progress ?? row.progressValue;

    const accuripText = patch.accuripText === null ? "" : patch.accuripText ?? row.accuripText;
    const accuripConfidence = patch.accuripConfidence === undefined ? row.accuripConfidence : patch.accuripConfidence;
    const accuripMaxConfidence =
      patch.accuripMaxConfidence === undefined ? row.accuripMaxConfidence : patch.accuripMaxConfidence;

    if (patch.title !== undefined) {
      row.originalTitle = title || `Track ${String(number).padStart(2, "0")}`;
      if (!row.titleDirty) {
        row.titleInput.value = row.originalTitle;
      }
    }

    if (patch.artist !== undefined) {
      row.originalArtist = artist || "";
      if (!row.artistDirty) {
        row.artistInput.value = row.originalArtist;
      }
    }

    row.durationCell.textContent = duration || "";
    row.durationCell.title = row.durationCell.textContent;

    row.accuripText = accuripText || "";
    row.accuripConfidence = normalizeOptionalInt(accuripConfidence);
    row.accuripMaxConfidence = normalizeOptionalInt(accuripMaxConfidence);
    row.accuripCell.textContent = formatAccuripCell(row);
    row.accuripCell.title = row.accuripCell.textContent;

    applyTrackStatus(row, status);
    applyTrackProgress(row, progress);
    refreshTrackDirtyState(row);
  }

  function createTrackRow(trackNo) {
    const tbody = el("tracks-body");
    const tr = document.createElement("tr");
    tr.className = "track-row";

    const selectCell = document.createElement("td");
    const selectInput = document.createElement("input");
    selectInput.type = "checkbox";
    selectInput.checked = true;
    selectInput.addEventListener("change", () => {
      updateSelectAllState();
      debouncePreview();
    });
    selectCell.appendChild(selectInput);

    const numberCell = document.createElement("td");
    numberCell.textContent = String(trackNo).padStart(2, "0");

    const titleCell = document.createElement("td");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "track-meta-input";
    titleInput.value = `Track ${String(trackNo).padStart(2, "0")}`;
    titleInput.addEventListener("input", () => {
      refreshTrackDirtyState(rowRef);
      debouncePreview();
    });
    titleCell.appendChild(titleInput);

    const artistCell = document.createElement("td");
    const artistInput = document.createElement("input");
    artistInput.type = "text";
    artistInput.className = "track-meta-input";
    artistInput.value = "";
    artistInput.addEventListener("input", () => {
      refreshTrackDirtyState(rowRef);
      debouncePreview();
    });
    artistCell.appendChild(artistInput);

    const durationCell = document.createElement("td");

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = "status-pill status-detected";
    statusPill.textContent = t("trackStatus.detected");
    statusCell.appendChild(statusPill);

    const progressCell = document.createElement("td");
    const progressWrap = document.createElement("div");
    progressWrap.className = "progress-wrap";

    const progressBar = document.createElement("div");
    progressBar.className = "progress-bar";
    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    progressBar.appendChild(progressFill);

    const progressPct = document.createElement("span");
    progressPct.className = "progress-pct";
    progressPct.textContent = "0.0%";

    progressWrap.append(progressBar, progressPct);
    progressCell.appendChild(progressWrap);

    const accuripCell = document.createElement("td");

    tr.append(selectCell, numberCell, titleCell, artistCell, durationCell, statusCell, progressCell, accuripCell);

    const existingRows = Array.from(tbody.querySelectorAll("tr"));
    const insertBefore = existingRows.find((rowNode) => {
      const value = Number.parseInt(rowNode.children[1].textContent, 10);
      return value > trackNo;
    });

    if (insertBefore) {
      tbody.insertBefore(tr, insertBefore);
    } else {
      tbody.appendChild(tr);
    }

    const rowRef = {
      tr,
      trackNo,
      selectedInput: selectInput,
      titleInput,
      artistInput,
      durationCell,
      statusCell: statusPill,
      progressFill,
      progressPct,
      accuripCell,
      statusValue: "detected",
      progressValue: 0,
      accuripText: "",
      accuripConfidence: null,
      accuripMaxConfidence: null,
      originalTitle: titleInput.value,
      originalArtist: artistInput.value,
      titleDirty: false,
      artistDirty: false,
    };

    return rowRef;
  }

  function refreshTrackDirtyState(row) {
    row.titleDirty = row.titleInput.value.trim() !== row.originalTitle.trim();
    row.artistDirty = row.artistInput.value.trim() !== row.originalArtist.trim();

    row.titleInput.classList.toggle("is-dirty", row.titleDirty);
    row.artistInput.classList.toggle("is-dirty", row.artistDirty);
    row.tr.classList.toggle("meta-dirty", row.titleDirty || row.artistDirty);
  }

  function applyTrackStatus(row, status) {
    const normalized = normalizeTrackStatus(status);
    row.statusValue = normalized;

    row.tr.classList.toggle("track-running", normalized === "running");
    row.statusCell.className = `status-pill ${statusClass(normalized)}`;
    row.statusCell.textContent = statusLabel(normalized);
    row.statusCell.title = row.statusCell.textContent;
  }

  function applyTrackProgress(row, value) {
    const parsed = Number.parseFloat(String(value));
    const normalized = Number.isNaN(parsed) ? row.progressValue : clamp(parsed, 0, 100);
    row.progressValue = normalized;

    row.progressFill.style.width = `${normalized}%`;
    row.progressPct.textContent = `${normalized.toFixed(1)}%`;
  }

  function formatAccuripCell(row) {
    const confidence = normalizeOptionalInt(row.accuripConfidence);
    const maxConfidence = normalizeOptionalInt(row.accuripMaxConfidence);
    const text = String(row.accuripText || "").trim();

    if (confidence !== null && maxConfidence !== null) {
      return `${confidence}/${maxConfidence}`;
    }
    if (confidence === null && maxConfidence !== null) {
      return `max ${maxConfidence}`;
    }
    if (confidence !== null) {
      return String(confidence);
    }
    return text;
  }

  function normalizeTrackStatus(status) {
    const s = String(status || "").toLowerCase();
    if (["running", "ripping", "encoding"].includes(s)) {
      return "running";
    }
    if (["done", "finished", "ok"].includes(s)) {
      return "done";
    }
    if (["error", "failed"].includes(s)) {
      return "error";
    }
    if (["queued", "waiting"].includes(s)) {
      return "queued";
    }
    return "detected";
  }

  function statusClass(status) {
    if (status === "running") {
      return "status-running";
    }
    if (status === "done") {
      return "status-done";
    }
    if (status === "error") {
      return "status-error";
    }
    if (status === "queued") {
      return "status-queued";
    }
    return "status-detected";
  }

  function statusLabel(status) {
    if (status === "running") {
      return t("trackStatus.running");
    }
    if (status === "done") {
      return t("trackStatus.done");
    }
    if (status === "error") {
      return t("trackStatus.error");
    }
    if (status === "queued") {
      return t("trackStatus.queued");
    }
    return t("trackStatus.detected");
  }

  function updateSelectAllState() {
    const allRows = Array.from(state.trackRows.values());
    const allSelected = allRows.length > 0 && allRows.every((row) => row.selectedInput.checked);
    const anySelected = allRows.some((row) => row.selectedInput.checked);

    const selectAll = el("tracks-select-all");
    selectAll.checked = allSelected;
    selectAll.indeterminate = !allSelected && anySelected;
  }

  function onSelectAllTracksChanged() {
    const enabled = el("tracks-select-all").checked;
    state.trackRows.forEach((row) => {
      row.selectedInput.checked = enabled;
    });
    updateSelectAllState();
    debouncePreview();
  }

  function refreshAllTrackLabels() {
    state.trackRows.forEach((row) => {
      applyTrackStatus(row, row.statusValue);
      row.accuripCell.textContent = formatAccuripCell(row);
      row.accuripCell.title = row.accuripCell.textContent;
    });

    updateStatusPanel();
  }

  function getAllSchemeTargetIds() {
    return ["directory-scheme", "track-scheme", "log-scheme", "cue-scheme"];
  }

  function syncAllSchemeBuildersFromInputs() {
    getAllSchemeTargetIds().forEach((id) => {
      const input = el(id);
      if (!input) {
        return;
      }
      state.schemeComposer.partsByTarget[id] = parseSchemeParts(input.value || "");
    });
  }

  function normalizeSchemeMode(value) {
    return value === "manual" ? "manual" : "auto";
  }

  function initializeSchemeModes() {
    getAllSchemeTargetIds().forEach((id) => {
      state.schemeComposer.modeByTarget[id] = normalizeSchemeMode(state.schemeComposer.modeByTarget[id]);
    });
  }

  function setSchemeModeForTarget(targetId, mode, persist = true) {
    if (!targetId || !getAllSchemeTargetIds().includes(targetId)) {
      return;
    }
    const normalized = normalizeSchemeMode(mode);
    state.schemeComposer.modeByTarget[targetId] = normalized;

    if ((state.schemeComposer.activeTarget || "directory-scheme") === targetId) {
      document.querySelectorAll(".toggle-row[data-group='scheme-mode'] .toggle-option").forEach((node) => {
        node.classList.toggle("is-active", node.dataset.value === normalized);
      });
    }

    applyModeVisibility();
    debouncePreview();
    if (persist) {
      saveUiPreferencesDebounced();
    }
  }

  function parseSchemeParts(rawValue) {
    const value = String(rawValue || "");
    if (!value) {
      return [];
    }

    const parts = [];
    const fragments = value.split(/(\{[^{}]+\})/g).filter((chunk) => chunk.length > 0);
    fragments.forEach((fragment) => {
      if (SCHEME_TOKEN_SET.has(fragment)) {
        parts.push({ type: "token", value: fragment });
      } else {
        parts.push({ type: "text", value: fragment });
      }
    });
    return parts;
  }

  function setActiveSchemeTarget(targetId) {
    if (!targetId || !getAllSchemeTargetIds().includes(targetId)) {
      return;
    }
    state.schemeComposer.activeTarget = targetId;
    document.querySelectorAll(".scheme-target").forEach((node) => {
      const active = node.dataset.target === targetId;
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-selected", active ? "true" : "false");
    });
    setSchemeModeForTarget(targetId, state.schemeComposer.modeByTarget[targetId], false);
    renderSchemeActiveSummary();
    renderActiveSchemeComposer();
    applyModeVisibility();
  }

  function renderSchemeTokens() {
    const container = el("scheme-tokens");
    container.innerHTML = "";

    SCHEME_TOKENS.forEach((item) => {
      const token = item.token;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scheme-token";
      button.textContent = t(item.labelKey);
      button.title = t(item.labelKey);
      button.draggable = true;
      button.dataset.token = token;
      button.addEventListener("dragstart", (event) => {
        state.schemeComposer.dragging = {
          source: "palette",
          token,
        };
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "copyMove";
          event.dataTransfer.setData("text/plain", token);
        }
      });
      button.addEventListener("dragend", () => {
        state.schemeComposer.dragging = null;
      });
      button.addEventListener("click", () => {
        const current = getActiveSchemeParts();
        current.push({ type: "token", value: token });
        setActiveSchemeParts(current);
      });
      container.appendChild(button);
    });
  }

  function getActiveSchemeParts() {
    const targetId = state.schemeComposer.activeTarget || "directory-scheme";
    const raw = state.schemeComposer.partsByTarget[targetId];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => ({ ...item }));
  }

  function setActiveSchemeParts(parts, persist = true) {
    const targetId = state.schemeComposer.activeTarget || "directory-scheme";
    state.schemeComposer.partsByTarget[targetId] = (parts || []).map((item) => ({
      type: item.type === "token" ? "token" : "text",
      value: String(item.value || ""),
    }));

    if (persist) {
      persistActiveSchemePartsToInput();
      debouncePreview();
    }
    renderSchemeActiveSummary();
    renderActiveSchemeComposer();
  }

  function persistActiveSchemePartsToInput() {
    const targetId = state.schemeComposer.activeTarget || "directory-scheme";
    const input = el(targetId);
    if (!input) {
      return;
    }
    const parts = state.schemeComposer.partsByTarget[targetId] || [];
    input.value = parts.map((item) => String(item.value || "")).join("");
  }

  function tokenLabel(token) {
    const item = SCHEME_TOKEN_MAP.get(token);
    if (!item) {
      return token;
    }
    return t(item.labelKey);
  }

  function renderSchemeActiveSummary() {
    const targetId = state.schemeComposer.activeTarget || "directory-scheme";
    const titleKey = `output.${targetId.replace("-scheme", "Scheme")}`;
    el("scheme-active-title").textContent = t(titleKey);

    const parts = state.schemeComposer.partsByTarget[targetId] || [];
    if (parts.length === 0) {
      el("scheme-active-preview").textContent = t("output.schemeEmpty");
      return;
    }

    const readable = parts.map((part) => {
      if (part.type === "token") {
        return tokenLabel(part.value);
      }
      return part.value;
    });
    el("scheme-active-preview").textContent = readable.join(" • ");
  }

  function addLiteralSchemePart() {
    const literalInput = el("scheme-literal-input");
    const text = String(literalInput.value || "");
    if (!text) {
      return;
    }

    const current = getActiveSchemeParts();
    current.push({ type: "text", value: text });
    setActiveSchemeParts(current);
    literalInput.value = "";
  }

  function clearActiveScheme() {
    setActiveSchemeParts([]);
  }

  function renderActiveSchemeComposer() {
    const dropzone = el("scheme-dropzone");
    dropzone.innerHTML = "";

    const targetId = state.schemeComposer.activeTarget || "directory-scheme";
    const parts = state.schemeComposer.partsByTarget[targetId] || [];

    if (parts.length === 0) {
      const hint = document.createElement("div");
      hint.className = "scheme-drop-hint";
      hint.textContent = t("output.schemeDropHint");
      dropzone.appendChild(hint);
      return;
    }

    parts.forEach((part, index) => {
      const chip = document.createElement("div");
      chip.className = `scheme-chip ${part.type === "token" ? "token" : "text"}`;
      chip.dataset.index = String(index);
      chip.draggable = true;

      const text = document.createElement("span");
      text.className = "scheme-chip-text";
      if (part.type === "token") {
        text.textContent = tokenLabel(part.value);
        text.title = tokenLabel(part.value);
      } else {
        text.textContent = part.value;
        text.title = part.value;
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "scheme-chip-remove";
      remove.textContent = "×";
      remove.title = t("button.remove");
      remove.addEventListener("click", () => {
        const next = getActiveSchemeParts();
        next.splice(index, 1);
        setActiveSchemeParts(next);
      });

      chip.addEventListener("dragstart", (event) => {
        state.schemeComposer.dragging = {
          source: "builder",
          index,
        };
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(index));
        }
      });
      chip.addEventListener("dragend", () => {
        state.schemeComposer.dragging = null;
      });

      chip.append(text, remove);
      dropzone.appendChild(chip);
    });
  }

  function onSchemeDropzoneDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    el("scheme-dropzone").classList.add("is-over");
  }

  function onSchemeDropzoneDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      el("scheme-dropzone").classList.remove("is-over");
    }
  }

  function onSchemeDropzoneDrop(event) {
    event.preventDefault();
    el("scheme-dropzone").classList.remove("is-over");

    const dragging = state.schemeComposer.dragging;
    state.schemeComposer.dragging = null;
    if (!dragging) {
      return;
    }

    const current = getActiveSchemeParts();
    const dropIndex = computeSchemeDropIndex(event, current.length);

    if (dragging.source === "palette") {
      current.splice(dropIndex, 0, { type: "token", value: dragging.token });
      setActiveSchemeParts(current);
      return;
    }

    if (dragging.source === "builder") {
      const from = Number.parseInt(String(dragging.index), 10);
      if (Number.isNaN(from) || from < 0 || from >= current.length) {
        return;
      }

      const [item] = current.splice(from, 1);
      if (!item) {
        return;
      }
      const to = from < dropIndex ? dropIndex - 1 : dropIndex;
      current.splice(clamp(to, 0, current.length), 0, item);
      setActiveSchemeParts(current);
    }
  }

  function computeSchemeDropIndex(event, fallback) {
    const chips = Array.from(el("scheme-dropzone").querySelectorAll(".scheme-chip"));
    if (chips.length === 0) {
      return 0;
    }

    const x = event.clientX;
    for (const chip of chips) {
      const rect = chip.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      if (x < midpoint) {
        const index = Number.parseInt(String(chip.dataset.index || "0"), 10);
        return Number.isNaN(index) ? fallback : index;
      }
    }

    return fallback;
  }

  function renderOutputCheckboxes() {
    const container = el("outputs-container");
    container.innerHTML = "";

    outputs.forEach((output) => {
      const wrapper = document.createElement("label");
      wrapper.className = "output-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = output;
      checkbox.dataset.role = "output";
      const text = document.createElement("span");
      text.className = "output-pill";
      text.textContent = output;
      wrapper.append(checkbox, text);
      container.appendChild(wrapper);
    });
  }

  function renderSelectOptions(id, values) {
    const select = el(id);
    select.innerHTML = "";
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
  }

  function applyDefaults() {
    el("offset").value = defaults.offset ?? 0;
    el("max-retries").value = defaults.max_retries ?? 10;
    el("ripping-retries").value = valueOrEmpty(defaults.ripping_retries);
    el("speed").value = valueOrEmpty(defaults.speed);
    const paranoiaDefault = String(defaults.paranoia_level || "max").trim().toLowerCase();
    if (paranoiaDefault === "none") {
      state.modes.paranoia = "none";
      el("paranoia-value").value = "0";
    } else if (paranoiaDefault === "max") {
      state.modes.paranoia = "max";
      el("paranoia-value").value = "0";
    } else {
      state.modes.paranoia = "numeric";
      el("paranoia-value").value = paranoiaDefault;
    }

    el("overread-leadinout").checked = !!defaults.overread_leadinout;
    el("decode-hdcd").checked = !!defaults.decode_hdcd;

    if (defaults.force_deemphasis) {
      state.modes.deemphasis = "force";
    } else if (defaults.disable_deemphasis) {
      state.modes.deemphasis = "disable";
    } else {
      state.modes.deemphasis = "auto";
    }

    el("bitrate").value = defaults.bitrate ?? 256;
    el("sanitation").value = defaults.sanitation || "unicode";
    el("directory-scheme").value = defaults.directory_scheme || "";
    el("track-scheme").value = defaults.track_scheme || "";
    el("log-scheme").value = defaults.log_scheme || "";
    el("cue-scheme").value = defaults.cue_scheme || "";

    el("output-directory-manual").value = "";

    el("release").value = defaults.release || "";
    el("disc-number").value = valueOrEmpty(defaults.disc_number);
    el("total-discs").value = valueOrEmpty(defaults.total_discs);
    el("cover-arts").value = "";
    el("coverart-lookup-size").value = String(defaults.coverart_lookup_size ?? -1);

    el("enable-mb").checked = !defaults.disable_mb;
    el("enable-accurip").checked = !defaults.disable_accurip;
    el("enable-coverart-db").checked = !defaults.disable_coverart_db;
    el("enable-embedding").checked = !defaults.disable_coverart_embedding;
    el("enable-replaygain").checked = !defaults.disable_replaygain;
    el("eject-on-success").checked = !!defaults.eject_on_success;
    const selected = new Set(defaults.outputs || ["flac"]);
    document.querySelectorAll("input[data-role='output']").forEach((node) => {
      node.checked = selected.has(node.value);
    });

    state.modes.offset = "manual";
    state.modes.device = "auto";
    state.modes.outputDir = "workdir";
    state.workspace.showAll = false;
    state.discOriginal = {
      album: "",
      album_artist: "",
      date: "",
      release: defaults.release || "",
      disc_number: normalizeOptionalInt(defaults.disc_number),
      total_discs: normalizeOptionalInt(defaults.total_discs),
    };
    updateDiscMetaDirtyIndicators();
  }

  function effectiveWorkingDirectoryForRip() {
    if (state.modes.outputDir === "manual") {
      const manual = el("output-directory-manual").value.trim();
      if (manual) {
        return manual;
      }
    }

    return state.settings.working_directory || "./output";
  }

  function collectConfig() {
    const selectedTracks = getSelectedTrackNumbers();
    const allTrackNumbers = Array.from(state.trackRows.keys()).sort((a, b) => a - b);

    const trackSelection = selectedTracks.length === allTrackNumbers.length ? [] : selectedTracks;

    const forceDeemphasis = state.modes.deemphasis === "force";
    const disableDeemphasis = state.modes.deemphasis === "disable";
    const paranoiaLevel = resolveParanoiaForConfig();

    const albumMeta = collectAlbumMetadataPatch();

    return {
      device_path: resolveDevicePathForCommand(),
      offset: state.modes.offset === "manual" ? intOrNull(el("offset").value) : null,
      max_retries: intOrNull(el("max-retries").value),
      ripping_retries: intOrNull(el("ripping-retries").value),
      speed: intOrNull(el("speed").value),
      pregap_rules: parsePregapRules(el("pregap-rules").value),
      paranoia_level: paranoiaLevel,
      overread_leadinout: el("overread-leadinout").checked,
      decode_hdcd: el("decode-hdcd").checked,
      force_deemphasis: forceDeemphasis,
      disable_deemphasis: disableDeemphasis,
      disable_replaygain: !el("enable-replaygain").checked,
      outputs: getSelectedOutputs(),
      bitrate: floatOrNull(el("bitrate").value),
      directory_scheme: schemeValueForConfig("directory-scheme"),
      track_scheme: schemeValueForConfig("track-scheme"),
      log_scheme: schemeValueForConfig("log-scheme"),
      cue_scheme: schemeValueForConfig("cue-scheme"),
      track_selection: trackSelection,
      sanitation: el("sanitation").value,
      album_metadata: albumMeta,
      track_metadata: collectTrackMetadataPatch(selectedTracks),
      release: el("release").value.trim(),
      disc_number: intOrNull(el("disc-number").value),
      total_discs: intOrNull(el("total-discs").value),
      cover_arts: parseCoverArts(el("cover-arts").value),
      disable_mb: !el("enable-mb").checked,
      disable_accurip: !el("enable-accurip").checked,
      disable_coverart_db: !el("enable-coverart-db").checked,
      coverart_lookup_size: intOrNull(el("coverart-lookup-size").value),
      disable_coverart_embedding: !el("enable-embedding").checked,
      eject_on_success: el("eject-on-success").checked,
      find_drive_offset: state.modes.offset !== "manual",
      print_info_only: false,
      print_version: false,
      show_help: false,
    };
  }

  function resolveParanoiaForConfig() {
    if (state.modes.paranoia === "none") {
      return "none";
    }
    if (state.modes.paranoia === "max") {
      return "max";
    }

    const numeric = intOrNull(el("paranoia-value").value);
    if (numeric === null) {
      throw new Error(t("error.paranoiaRequired"));
    }
    if (numeric < 0) {
      throw new Error(t("error.paranoiaInvalid"));
    }
    return String(numeric);
  }

  function schemeValueForConfig(targetId) {
    const mode = normalizeSchemeMode(state.schemeComposer.modeByTarget[targetId]);
    if (mode !== "manual") {
      return "";
    }
    const input = el(targetId);
    return input ? String(input.value || "") : "";
  }

  function collectAlbumMetadataPatch() {
    const parts = [];

    const album = el("disc-album").value.trim();
    const artist = el("disc-artist").value.trim();
    const date = el("disc-date").value.trim();

    const albumDirty = album !== String(state.discOriginal.album || "").trim();
    const artistDirty = artist !== String(state.discOriginal.album_artist || "").trim();
    const dateDirty = date !== String(state.discOriginal.date || "").trim();
    updateDiscMetaDirtyIndicators();

    if (albumDirty && album) {
      parts.push(`album=${album}`);
    }
    if (artistDirty && artist) {
      parts.push(`album_artist=${artist}`);
    }
    if (dateDirty && date) {
      parts.push(`date=${date}`);
    }

    return parts.join(":");
  }

  function updateDiscMetaDirtyIndicators() {
    const albumDirty = el("disc-album").value.trim() !== String(state.discOriginal.album || "").trim();
    const artistDirty = el("disc-artist").value.trim() !== String(state.discOriginal.album_artist || "").trim();
    const dateDirty = el("disc-date").value.trim() !== String(state.discOriginal.date || "").trim();
    const releaseDirty = el("release").value.trim() !== String(state.discOriginal.release || "").trim();
    const discNoDirty = normalizeOptionalInt(el("disc-number").value) !== normalizeOptionalInt(state.discOriginal.disc_number);
    const totalDiscsDirty =
      normalizeOptionalInt(el("total-discs").value) !== normalizeOptionalInt(state.discOriginal.total_discs);

    el("disc-album").classList.toggle("is-dirty", albumDirty);
    el("disc-artist").classList.toggle("is-dirty", artistDirty);
    el("disc-date").classList.toggle("is-dirty", dateDirty);
    el("release").classList.toggle("is-dirty", releaseDirty);
    el("disc-number").classList.toggle("is-dirty", discNoDirty);
    el("total-discs").classList.toggle("is-dirty", totalDiscsDirty);
  }

  function collectTrackMetadataPatch(selectedTracks) {
    const selected = new Set(selectedTracks);
    const patches = [];

    state.trackRows.forEach((row, trackNo) => {
      if (!selected.has(trackNo)) {
        return;
      }

      const parts = [];
      const title = row.titleInput.value.trim();
      const artist = row.artistInput.value.trim();

      if (row.titleDirty && title) {
        parts.push(`title=${title}`);
      }

      if (row.artistDirty && artist) {
        parts.push(`artist=${artist}`);
      }

      if (parts.length === 0) {
        return;
      }

      patches.push({
        track: trackNo,
        metadata: parts.join(":"),
      });
    });

    return patches;
  }

  function getSelectedTrackNumbers() {
    const selected = [];

    state.trackRows.forEach((row, trackNo) => {
      if (row.selectedInput.checked) {
        selected.push(trackNo);
      }
    });

    selected.sort((a, b) => a - b);
    return selected;
  }

  function getSelectedOutputs() {
    const selected = [];
    document.querySelectorAll("input[data-role='output']").forEach((node) => {
      if (node.checked) {
        selected.push(node.value);
      }
    });
    return selected;
  }

  function refreshPreview() {
    if (!state.advancedVisible) {
      return;
    }

    let config = null;
    let scanConfig = null;
    let ripConfig = null;
    const token = ++state.previewRenderToken;
    try {
      config = collectConfig();
      scanConfig = config;
      ripConfig = config;
    } catch (error) {
      scanConfig = collectScanPreviewFallbackConfig();
      ripConfig = null;
      showError(error.message || String(error));
    }

    const requests = [];
    requests.push(
      apiPost("/api/preview", {
        binary_path: state.settings.binary_path,
        config: scanConfig,
        mode: "scan",
      }),
    );
    if (ripConfig) {
      requests.push(
        apiPost("/api/preview", {
          binary_path: state.settings.binary_path,
          config: ripConfig,
          mode: "rip",
        }),
      );
    } else {
      requests.push(Promise.resolve({ shell_command: "-" }));
    }

    Promise.allSettled(requests)
      .then((results) => {
        if (token !== state.previewRenderToken) {
          return;
        }
        const scanPreview = results[0] && results[0].status === "fulfilled" ? results[0].value : null;
        const ripPreview = results[1] && results[1].status === "fulfilled" ? results[1].value : null;
        const scanCmd = String((scanPreview && scanPreview.shell_command) || "").trim() || "-";
        const ripCmd = String((ripPreview && ripPreview.shell_command) || "").trim() || "-";
        const lines = [
          `[${t("advanced.scanCommand")}]`,
          scanCmd,
          "",
          `[${t("advanced.ripCommand")}]`,
          ripCmd,
        ];
        el("command-preview").textContent = lines.join("\n");

        if (results.some((item) => item.status === "rejected")) {
          const firstError = results.find((item) => item.status === "rejected");
          if (firstError && firstError.reason) {
            showError(firstError.reason.message || String(firstError.reason));
          }
        }
      })
      .catch((error) => {
        if (token !== state.previewRenderToken) {
          return;
        }
        showError(error.message);
        el("command-preview").textContent = "";
      });
  }

  function collectScanPreviewFallbackConfig() {
    return {
      device_path: resolveDevicePathForCommand(),
      offset: normalizeOptionalInt(el("offset").value),
      find_drive_offset: state.modes.offset !== "manual",
    };
  }

  function debouncePreview() {
    if (state.previewTimer !== null) {
      window.clearTimeout(state.previewTimer);
    }
    state.previewTimer = window.setTimeout(refreshPreview, 260);
  }

  function appendLogs(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    const log = el("job-log");
    const parts = [];

    lines.forEach((entry) => {
      if (!entry || typeof entry.line !== "string") {
        return;
      }
      parts.push(entry.line);
    });

    if (parts.length === 0) {
      return;
    }

    log.textContent += `${parts.join("\n")}\n`;
    if (log.textContent.length > 900000) {
      log.textContent = log.textContent.slice(-650000);
    }
    log.scrollTop = log.scrollHeight;
  }

  async function copyAdvancedLog() {
    const text = String(el("job-log").textContent || "");
    if (!text.trim()) {
      showAdvancedLogFeedback(t("advanced.logEmpty"));
      return;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const helper = document.createElement("textarea");
        helper.value = text;
        helper.setAttribute("readonly", "true");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      showAdvancedLogFeedback(t("advanced.logCopied"));
    } catch (_) {
      showAdvancedLogFeedback(t("advanced.logCopyFailed"));
    }
  }

  function downloadAdvancedLog() {
    const text = String(el("job-log").textContent || "");
    if (!text.trim()) {
      showAdvancedLogFeedback(t("advanced.logEmpty"));
      return;
    }

    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cyanrip-log-${stamp}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 800);
    showAdvancedLogFeedback(t("advanced.logDownloaded"));
  }

  function showAdvancedLogFeedback(message) {
    const node = el("advanced-log-feedback");
    node.textContent = message || "";
    if (state.logFeedbackTimer !== null) {
      window.clearTimeout(state.logFeedbackTimer);
    }
    if (!message) {
      return;
    }
    state.logFeedbackTimer = window.setTimeout(() => {
      if (el("advanced-log-feedback").textContent === message) {
        el("advanced-log-feedback").textContent = "";
      }
      state.logFeedbackTimer = null;
    }, 1800);
  }

  function updateStatusPanel() {
    const statusLabel = el("status-label");
    const statusIndicator = el("status-indicator");
    const statusCard = el("status-card");

    let label = t("status.idle");
    let indicatorClass = "idle";
    let indicatorActive = false;

    if (state.scanInProgress) {
      label = t("status.scanning");
      indicatorClass = "active";
      indicatorActive = true;
    } else {
      const phase = String(state.session.phase || "idle");
      if (phase === "ripping") {
        label = t("status.ripping");
        indicatorClass = "active";
        indicatorActive = true;
      } else if (phase === "scanned") {
        label = t("status.scanned");
        indicatorClass = "success";
      } else if (phase === "finished") {
        label = t("status.ripped");
        indicatorClass = "success";
      } else if (phase === "failed" || phase === "scan_error") {
        label = t("status.failed");
        indicatorClass = "error";
      } else if (phase === "stopped") {
        label = t("status.stopped");
      } else if (phase === "scan_required") {
        label = t("status.scanRequired");
        indicatorClass = "error";
      }
    }

    const workflow = currentWorkflowPhase();

    statusLabel.textContent = label;
    statusLabel.title = label;

    statusIndicator.className = "status-indicator";
    statusIndicator.classList.add(indicatorClass);
    if (indicatorActive) {
      statusIndicator.classList.add("active");
    }

    statusCard.classList.remove("active", "success", "error");
    if (indicatorActive) {
      statusCard.classList.add("active");
    } else if (indicatorClass === "success") {
      statusCard.classList.add("success");
    } else if (indicatorClass === "error") {
      statusCard.classList.add("error");
    }

    const progress = computeOverallProgress();
    const progressText = t("status.tracks", {
      done: progress.done,
      total: progress.total,
      percent: progress.percent.toFixed(1),
    });
    el("status-progress").textContent = progressText;
    el("status-progress").title = progressText;

    let etaText = t("status.eta", { eta: "-" });
    if (state.scanInProgress) {
      etaText = t("status.eta", { eta: t("status.etaScanning") });
    } else if (state.runnerStatus && state.runnerStatus.is_running && state.ripMeta.eta) {
      etaText = t("status.eta", { eta: state.ripMeta.eta });
    }
    el("status-eta").textContent = etaText;
    el("status-eta").title = etaText;

    const phaseText = t(`workflow.phase.${workflow.labelKey}`);
    el("status-phase").textContent = t("workflow.phaseLine", { phase: phaseText });
    el("status-phase").title = phaseText;

    renderWorkflowSteps(workflow.name);
    applyWorkflowControls(workflow);
  }

  function currentWorkflowPhase() {
    if (state.scanInProgress) {
      return { name: "scan_running", labelKey: "preScan" };
    }

    const raw = String(state.session.phase || "idle");
    if (raw === "scanning") {
      return { name: "scan_running", labelKey: "preScan" };
    }
    if (raw === "scanned") {
      return { name: "post_scan", labelKey: "postScan" };
    }
    if (raw === "ripping" || (state.runnerStatus && state.runnerStatus.is_running)) {
      return { name: "rip_running", labelKey: "ripping" };
    }
    if (["finished", "failed", "stopped"].includes(raw)) {
      return { name: "post_rip", labelKey: "postRip" };
    }
    return { name: "pre_scan", labelKey: "preScan" };
  }

  function renderWorkflowSteps(phaseName) {
    const pre = el("workflow-step-pre");
    const review = el("workflow-step-review");
    const post = el("workflow-step-post");

    pre.textContent = t("workflow.step.preScan");
    review.textContent = t("workflow.step.postScan");
    post.textContent = t("workflow.step.postRip");

    pre.classList.remove("is-active", "is-complete");
    review.classList.remove("is-active", "is-complete");
    post.classList.remove("is-active", "is-complete");

    if (phaseName === "pre_scan" || phaseName === "scan_running") {
      pre.classList.add("is-active");
      return;
    }

    pre.classList.add("is-complete");
    if (phaseName === "post_scan" || phaseName === "rip_running") {
      review.classList.add("is-active");
      return;
    }

    review.classList.add("is-complete");
    post.classList.add("is-active");
  }

  function applyWorkflowControls(workflow) {
    const running = workflow.name === "rip_running" || workflow.name === "scan_running";
    const inPreScan = workflow.name === "pre_scan" || workflow.name === "scan_running";

    updatePrimaryActionButton(workflow);

    el("action-primary").disabled = running;
    el("action-stop").disabled = !running;
    el("action-eject").disabled = running;
    el("action-back-to-scan").disabled = running || inPreScan;

    const allowDiscAndTrackEditing = !running;
    el("tracks-select-all").disabled = !allowDiscAndTrackEditing;
    state.trackRows.forEach((row) => {
      row.selectedInput.disabled = !allowDiscAndTrackEditing;
      row.titleInput.disabled = !allowDiscAndTrackEditing;
      row.artistInput.disabled = !allowDiscAndTrackEditing;
    });

    applyPhasePanelFocus(workflow.name);
    applyWorkspaceVisibility(workflow.name);
  }

  function updatePrimaryActionButton(workflow) {
    const button = el("action-primary");
    const startMode = workflow.name === "post_scan";
    const key = startMode ? "action.start" : "action.scan";
    button.dataset.i18nTitle = key;
    button.title = t(key);
    if (startMode) {
      button.innerHTML = "<svg viewBox='0 0 24 24' aria-hidden='true'><path d='M8 5v14l11-7L8 5Z' fill='currentColor'/></svg>";
    } else {
      button.innerHTML =
        "<svg viewBox='0 0 24 24' aria-hidden='true'><path d='M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 2a8 8 0 0 1 7.75 6H4.25A8 8 0 0 1 12 4Zm0 16a8 8 0 0 1-7.75-6h15.5A8 8 0 0 1 12 20Zm0-5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' fill='currentColor'/></svg>";
    }
  }

  function applyPhasePanelFocus(phaseName) {
    const focusByPhase = {
      pre_scan: ["disc-panel", "ripping-panel"],
      scan_running: ["disc-panel", "ripping-panel"],
      post_scan: ["disc-panel", "output-panel"],
      rip_running: ["output-panel", "metadata-panel"],
      post_rip: ["disc-panel", "metadata-panel"],
    };

    const focusSet = new Set(focusByPhase[phaseName] || []);
    ["disc-panel", "ripping-panel", "output-panel", "metadata-panel"].forEach((id) => {
      const panel = el(id);
      if (!panel) {
        return;
      }
      const focused = focusSet.has(id);
      panel.classList.toggle("phase-focus", focused);
      panel.classList.remove("phase-muted");
    });
  }

  function workspacePanelsForPhase(phaseName) {
    if (phaseName === "pre_scan" || phaseName === "scan_running") {
      return ["disc-panel", "ripping-panel"];
    }
    if (phaseName === "post_scan" || phaseName === "rip_running") {
      return ["disc-panel", "output-panel", "metadata-panel"];
    }
    if (phaseName === "post_rip") {
      return ["disc-panel"];
    }
    return ["disc-panel", "ripping-panel"];
  }

  function applyWorkspaceVisibility(phaseName) {
    const visiblePanels = state.workspace.showAll ? ["disc-panel", ...PANEL_IDS] : workspacePanelsForPhase(phaseName);
    const visibleSet = new Set(visiblePanels);

    ["disc-panel", ...PANEL_IDS].forEach((id) => {
      const panel = el(id);
      if (!panel) {
        return;
      }
      panel.classList.toggle("workspace-hidden", !visibleSet.has(id));
    });

    updateWorkspaceModeButton();
  }

  function updateWorkspaceModeButton() {
    const button = el("workspace-toggle");
    button.classList.toggle("is-active-mode", !!state.workspace.showAll);
  }

  function setWorkspaceShowAll(enabled) {
    state.workspace.showAll = !!enabled;
    applyWorkspaceVisibility(currentWorkflowPhase().name);
    updateToolbarButtonTitles();
    setCookie(COOKIE_WORKSPACE, state.workspace.showAll ? "all" : "phase");
    saveUiPreferencesDebounced();
  }

  function toggleWorkspaceMode() {
    setWorkspaceShowAll(!state.workspace.showAll);
  }

  function computeOverallProgress() {
    const selected = getSelectedTrackNumbers();
    const total = selected.length;
    if (total <= 0) {
      return { done: 0, total: 0, percent: 0 };
    }

    const selectedSet = new Set(selected);

    let done = 0;
    selectedSet.forEach((trackNo) => {
      const row = state.trackRows.get(trackNo);
      if (row && row.statusValue === "done") {
        done += 1;
      }
    });

    let currentFraction = 0;
    if (state.ripMeta.currentTrackNo && state.ripMeta.currentTrackProgress > 0) {
      const current = state.ripMeta.currentTrackNo;
      const row = state.trackRows.get(current);
      if (selectedSet.has(current) && row && row.statusValue !== "done") {
        currentFraction = clamp(state.ripMeta.currentTrackProgress / 100, 0, 1);
      }
    }

    const percent = clamp(((done + currentFraction) / total) * 100, 0, 100);
    return { done, total, percent };
  }

  function toggleAdvancedPanel(forceVisible = null) {
    const explicit = typeof forceVisible === "boolean" ? forceVisible : null;
    state.advancedVisible = explicit === null ? !state.advancedVisible : explicit;
    applyAdvancedDrawerState();
    setCookie(COOKIE_ADVANCED_OPEN, state.advancedVisible ? "on" : "off");
    saveUiPreferencesDebounced();
    if (state.advancedVisible) {
      refreshPreview();
    }
  }

  function applyAdvancedDrawerState() {
    const panel = el("advanced-panel");
    panel.classList.toggle("is-hidden", !state.advancedVisible);
    document.body.classList.toggle("advanced-open", state.advancedVisible);
    setAdvancedDrawerHeight(state.advancedHeight, false);
    syncAdvancedDrawerSpace();

    const btn = el("action-toggle-advanced");
    btn.classList.toggle("is-active-mode", state.advancedVisible);
    btn.title = state.advancedVisible ? t("action.advancedHide") : t("action.advanced");
    el("advanced-close").title = t("action.advancedHide");
  }

  function setAdvancedDrawerHeight(height, persist = true) {
    const viewportMax = Math.max(ADVANCED_MIN_HEIGHT, Math.floor(window.innerHeight * ADVANCED_MAX_HEIGHT_RATIO));
    const clamped = clamp(Math.round(Number(height) || ADVANCED_DEFAULT_HEIGHT), ADVANCED_MIN_HEIGHT, viewportMax);
    state.advancedHeight = clamped;
    el("advanced-panel").style.height = `${clamped}px`;
    syncAdvancedDrawerSpace();
    if (persist) {
      setCookie(COOKIE_ADVANCED_HEIGHT, String(clamped));
      saveUiPreferencesDebounced();
    }
  }

  function syncAdvancedDrawerSpace() {
    const panel = el("advanced-panel");
    const root = document.documentElement;
    if (!state.advancedVisible || panel.classList.contains("is-hidden")) {
      root.style.setProperty("--advanced-drawer-space", "0px");
      return;
    }
    const rect = panel.getBoundingClientRect();
    root.style.setProperty("--advanced-drawer-space", `${Math.max(0, Math.round(rect.height))}px`);
  }

  function initAdvancedDrawerResize() {
    const handle = el("advanced-resize-handle");
    const panel = el("advanced-panel");
    if (!handle) {
      return;
    }

    const beginResize = (clientY) => {
      state.activeDrawerResize = {
        startY: clientY,
        startHeight: state.advancedHeight,
      };
      panel.classList.add("is-resizing");
      panel.style.cursor = "ns-resize";
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      document.documentElement.style.userSelect = "none";
    };

    const onMove = (event) => {
      if (!state.activeDrawerResize) {
        return;
      }
      const delta = state.activeDrawerResize.startY - event.clientY;
      setAdvancedDrawerHeight(state.activeDrawerResize.startHeight + delta, false);
    };

    const onUp = () => {
      if (!state.activeDrawerResize) {
        return;
      }
      state.activeDrawerResize = null;
      panel.classList.remove("is-resizing");
      panel.style.cursor = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.documentElement.style.userSelect = "";
      setAdvancedDrawerHeight(state.advancedHeight, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (!state.advancedVisible) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      beginResize(event.clientY);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });

    panel.addEventListener("pointerdown", (event) => {
      if (!state.advancedVisible) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      const withinTopEdge = event.clientY >= rect.top && event.clientY <= rect.top + 30;
      if (!withinTopEdge) {
        return;
      }
      event.preventDefault();
      beginResize(event.clientY);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });

    window.addEventListener("resize", () => {
      setAdvancedDrawerHeight(state.advancedHeight, false);
      syncAdvancedDrawerSpace();
    });
  }

  function openSettingsModal() {
    const overlay = el("settings-overlay");
    overlay.classList.remove("is-hidden");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function closeSettingsModal() {
    const overlay = el("settings-overlay");
    overlay.classList.add("is-hidden");
    overlay.setAttribute("aria-hidden", "true");
    if (el("directory-picker-overlay").classList.contains("is-hidden")) {
      document.body.classList.remove("modal-open");
    }
  }

  function loadPreferenceCookies() {
    const cookieTheme = String(getCookie(COOKIE_THEME) || "").trim().toLowerCase();
    state.themeMode = THEME_ORDER.includes(cookieTheme) ? cookieTheme : "auto";

    const cookieAnim = String(getCookie(COOKIE_ANIM) || "").trim().toLowerCase();
    state.animationsEnabled = cookieAnim !== "off";

    const cookieAdvancedOpen = String(getCookie(COOKIE_ADVANCED_OPEN) || "").trim().toLowerCase();
    state.advancedVisible = cookieAdvancedOpen === "on";

    const cookieAdvancedHeight = Number.parseInt(String(getCookie(COOKIE_ADVANCED_HEIGHT) || ""), 10);
    if (!Number.isNaN(cookieAdvancedHeight)) {
      state.advancedHeight = cookieAdvancedHeight;
    }

    const cookieWorkspace = String(getCookie(COOKIE_WORKSPACE) || "").trim().toLowerCase();
    if (cookieWorkspace === "all") {
      state.workspace.showAll = true;
    } else if (cookieWorkspace === "phase") {
      state.workspace.showAll = false;
    }
  }

  function loadUiPreferences() {
    let parsed = {};
    try {
      parsed = JSON.parse(window.localStorage.getItem(UI_PREFS_KEY) || "{}");
    } catch (_) {
      parsed = {};
    }

    if (!parsed || typeof parsed !== "object") {
      state.uiPrefsLoaded = true;
      return;
    }

    const modes = parsed.modes && typeof parsed.modes === "object" ? parsed.modes : {};
    if (modes.offset === "auto" || modes.offset === "manual") {
      state.modes.offset = modes.offset;
    }
    if (["auto", "select", "path"].includes(modes.device)) {
      state.modes.device = modes.device;
    }
    if (modes.outputDir === "workdir" || modes.outputDir === "manual") {
      state.modes.outputDir = modes.outputDir;
    }
    if (["max", "numeric", "none"].includes(modes.paranoia)) {
      state.modes.paranoia = modes.paranoia;
    }
    if (["auto", "force", "disable"].includes(modes.deemphasis)) {
      state.modes.deemphasis = modes.deemphasis;
    }
    const legacyParanoia = String(parsed.paranoia_level || "").trim().toLowerCase();
    if (legacyParanoia === "none" || legacyParanoia === "max") {
      state.modes.paranoia = legacyParanoia;
    } else if (legacyParanoia && /^-?\d+$/.test(legacyParanoia)) {
      state.modes.paranoia = "numeric";
      setIfDefined("paranoia-value", legacyParanoia);
    }
    if (["auto", "force", "disable"].includes(parsed.deemphasis_mode)) {
      state.modes.deemphasis = parsed.deemphasis_mode;
    }

    if (typeof parsed.selectedDriveId === "string") {
      state.selectedDriveId = parsed.selectedDriveId;
    }
    if (state.selectedDriveId && Array.from(el("device-select").options).some((item) => item.value === state.selectedDriveId)) {
      el("device-select").value = state.selectedDriveId;
    }

    setIfDefined("offset", parsed.offset);
    setIfDefined("max-retries", parsed.max_retries);
    setIfDefined("ripping-retries", parsed.ripping_retries);
    setIfDefined("speed", parsed.speed);
    setIfDefined("paranoia-value", parsed.paranoia_value);
    setIfDefined("pregap-rules", parsed.pregap_rules_text);
    setIfDefined("bitrate", parsed.bitrate);
    setIfDefined("directory-scheme", parsed.directory_scheme);
    setIfDefined("track-scheme", parsed.track_scheme);
    setIfDefined("log-scheme", parsed.log_scheme);
    setIfDefined("cue-scheme", parsed.cue_scheme);
    setIfDefined("output-directory-manual", parsed.output_directory_manual);
    setIfDefined("device-path", parsed.device_path);
    setIfDefined("cover-arts", parsed.cover_arts_text);
    setIfDefined("coverart-lookup-size", parsed.coverart_lookup_size);
    setIfDefined("sanitation", parsed.sanitation);

    setCheckedIfDefined("overread-leadinout", parsed.overread_leadinout);
    setCheckedIfDefined("decode-hdcd", parsed.decode_hdcd);
    setCheckedIfDefined("enable-mb", parsed.enable_mb);
    setCheckedIfDefined("enable-accurip", parsed.enable_accurip);
    setCheckedIfDefined("enable-coverart-db", parsed.enable_coverart_db);
    setCheckedIfDefined("enable-embedding", parsed.enable_embedding);
    setCheckedIfDefined("enable-replaygain", parsed.enable_replaygain);
    setCheckedIfDefined("eject-on-success", parsed.eject_on_success);

    if (Array.isArray(parsed.outputs)) {
      const selectedOutputs = new Set(parsed.outputs.map((item) => String(item)));
      document.querySelectorAll("input[data-role='output']").forEach((node) => {
        node.checked = selectedOutputs.has(node.value);
      });
    }

    if (typeof parsed.advanced_visible === "boolean") {
      state.advancedVisible = parsed.advanced_visible;
    }
    if (Number.isFinite(parsed.advanced_height)) {
      state.advancedHeight = Number(parsed.advanced_height);
    }
    if (typeof parsed.workspace_show_all === "boolean") {
      state.workspace.showAll = parsed.workspace_show_all;
    } else if (parsed.workspace_mode && parsed.workspace_mode !== "auto") {
      state.workspace.showAll = true;
    }

    const schemeModes = parsed.scheme_modes && typeof parsed.scheme_modes === "object" ? parsed.scheme_modes : {};
    getAllSchemeTargetIds().forEach((id) => {
      state.schemeComposer.modeByTarget[id] = normalizeSchemeMode(schemeModes[id]);
    });
    if (getAllSchemeTargetIds().every((id) => !schemeModes[id])) {
      getAllSchemeTargetIds().forEach((id) => {
        state.schemeComposer.modeByTarget[id] = "auto";
      });
    }

    syncAllSchemeBuildersFromInputs();
    initializeSchemeModes();
    initializeBinaryToggleRows();
    initializeToggleModes();
    applyModeVisibility();
    applyWorkspaceVisibility(currentWorkflowPhase().name);
    updateDiscMetaDirtyIndicators();
    state.uiPrefsLoaded = true;
  }

  function saveUiPreferencesDebounced() {
    if (!state.uiPrefsLoaded) {
      return;
    }
    if (state.uiPrefsTimer !== null) {
      window.clearTimeout(state.uiPrefsTimer);
    }
    state.uiPrefsTimer = window.setTimeout(saveUiPreferences, 180);
  }

  function saveUiPreferences() {
    state.uiPrefsTimer = null;
    if (!state.uiPrefsLoaded) {
      return;
    }

    const payload = {
      modes: {
        offset: state.modes.offset,
        device: state.modes.device,
        outputDir: state.modes.outputDir,
        paranoia: state.modes.paranoia,
        deemphasis: state.modes.deemphasis,
      },
      selectedDriveId: el("device-select").value || state.selectedDriveId || "",
      offset: el("offset").value,
      max_retries: el("max-retries").value,
      ripping_retries: el("ripping-retries").value,
      speed: el("speed").value,
      paranoia_value: el("paranoia-value").value,
      pregap_rules_text: el("pregap-rules").value,
      overread_leadinout: el("overread-leadinout").checked,
      decode_hdcd: el("decode-hdcd").checked,
      outputs: getSelectedOutputs(),
      bitrate: el("bitrate").value,
      sanitation: el("sanitation").value,
      directory_scheme: el("directory-scheme").value,
      track_scheme: el("track-scheme").value,
      log_scheme: el("log-scheme").value,
      cue_scheme: el("cue-scheme").value,
      output_directory_manual: el("output-directory-manual").value,
      device_path: el("device-path").value,
      cover_arts_text: el("cover-arts").value,
      coverart_lookup_size: el("coverart-lookup-size").value,
      enable_mb: el("enable-mb").checked,
      enable_accurip: el("enable-accurip").checked,
      enable_coverart_db: el("enable-coverart-db").checked,
      enable_embedding: el("enable-embedding").checked,
      enable_replaygain: el("enable-replaygain").checked,
      eject_on_success: el("eject-on-success").checked,
      advanced_visible: state.advancedVisible,
      advanced_height: state.advancedHeight,
      workspace_show_all: state.workspace.showAll,
      scheme_modes: { ...state.schemeComposer.modeByTarget },
    };

    try {
      window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(payload));
    } catch (_) {
      // Keep running even if browser storage is unavailable/full.
    }
  }

  function setIfDefined(id, value) {
    if (value === undefined || value === null) {
      return;
    }
    const node = el(id);
    if (node) {
      node.value = String(value);
    }
  }

  function setCheckedIfDefined(id, value) {
    if (typeof value !== "boolean") {
      return;
    }
    const node = el(id);
    if (node) {
      node.checked = value;
    }
  }

  function cycleThemeMode() {
    const idx = THEME_ORDER.indexOf(state.themeMode);
    state.themeMode = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    setCookie(COOKIE_THEME, state.themeMode);
    applyThemeMode();
    updateToolbarButtonTitles();
  }

  function applyThemeMode() {
    const root = document.documentElement;
    if (state.themeMode === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", state.themeMode);
    }
  }

  function toggleAnimations() {
    state.animationsEnabled = !state.animationsEnabled;
    setCookie(COOKIE_ANIM, state.animationsEnabled ? "on" : "off");
    applyAnimationMode();
    updateToolbarButtonTitles();
  }

  function applyAnimationMode() {
    document.documentElement.setAttribute("data-animations", state.animationsEnabled ? "on" : "off");
  }

  function updateToolbarButtonTitles() {
    const darkPreferred = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolvedTheme = state.themeMode === "auto" ? (darkPreferred ? "dark" : "light") : state.themeMode;

    el("theme-toggle").title = state.themeMode === "auto"
      ? t("toolbar.theme.auto", { resolved: t(`toolbar.theme.mode.${resolvedTheme}`) })
      : t("toolbar.theme.fixed", { mode: t(`toolbar.theme.mode.${state.themeMode}`) });

    el("animation-toggle").title = state.animationsEnabled ? t("toolbar.animations.on") : t("toolbar.animations.off");
    el("settings-open").title = t("settings.title");
    el("workspace-toggle").title = state.workspace.showAll
      ? t("toolbar.workspace.showAll")
      : t("toolbar.workspace.phaseAdaptive");
    el("action-toggle-advanced").title = state.advancedVisible ? t("action.advancedHide") : t("action.advanced");
    el("advanced-close").title = t("action.advancedHide");
    updateWorkspaceModeButton();
  }

  async function initI18n() {
    state.fallbackDictionary = await loadLocaleDictionary("en");

    const initialLocale = normalizeLocale(initialSettings.language) || resolveBrowserLocale() || "en";
    await setLocale(initialLocale);

    applyTranslations();
  }

  function resolveBrowserLocale() {
    const browserLocales = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
    for (const locale of browserLocales) {
      const normalized = normalizeLocale(locale);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  function normalizeLocale(value) {
    if (!value) {
      return null;
    }

    const lower = String(value).trim().toLowerCase();
    if (!lower) {
      return null;
    }

    if (AVAILABLE_LOCALES.includes(lower)) {
      return lower;
    }

    const prefix = lower.split("-")[0];
    if (AVAILABLE_LOCALES.includes(prefix)) {
      return prefix;
    }

    return null;
  }

  async function setLocale(locale) {
    const normalized = normalizeLocale(locale) || "en";
    const dictionary = normalized === "en" ? state.fallbackDictionary : await loadLocaleDictionary(normalized);

    state.locale = normalized;
    state.dictionary = dictionary;
    document.documentElement.lang = normalized;
  }

  async function onSettingsLanguageChanged(event) {
    const requested = normalizeLocale(event.target.value) || "en";
    await setLocale(requested);
    applyTranslations();
    updateToolbarButtonTitles();
    refreshAllTrackLabels();
    updateStatusPanel();
  }

  function renderSettingsLanguageOptions() {
    const select = el("settings-language");
    select.innerHTML = "";

    AVAILABLE_LOCALES.forEach((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = code;
      select.appendChild(option);
    });
  }

  function ensureOptionHints() {
    const hintMap = {
      "settings-language": "hint.settingsLanguage",
      "settings-binary-path": "hint.settingsBinaryPath",
      "settings-working-directory": "hint.settingsWorkingDirectory",
      "settings-probe-binary": "hint.settingsBinaryProbe",
      "disc-album": "hint.discAlbum",
      "disc-artist": "hint.discArtist",
      "disc-date": "hint.discDate",
      "release": "hint.release",
      "disc-number": "hint.discNumber",
      "total-discs": "hint.totalDiscs",
      "offset-mode-auto": "hint.offsetMode",
      "offset-mode-manual": "hint.offsetMode",
      "offset": "hint.offsetMode",
      "device-mode-auto": "hint.deviceMode",
      "device-mode-select": "hint.deviceMode",
      "device-mode-path": "hint.deviceMode",
      "device-select": "hint.deviceMode",
      "device-path": "hint.deviceMode",
      "max-retries": "hint.maxRetries",
      "ripping-retries": "hint.checksumRetries",
      "speed": "hint.speed",
      "paranoia-mode-max": "hint.paranoia",
      "paranoia-mode-numeric": "hint.paranoia",
      "paranoia-mode-none": "hint.paranoia",
      "paranoia-value": "hint.paranoia",
      "pregap-rules": "hint.pregapRules",
      "overread-leadinout": "hint.overread",
      "decode-hdcd": "hint.hdcd",
      "deemphasis-mode-auto": "hint.deemphasis",
      "deemphasis-mode-force": "hint.deemphasis",
      "deemphasis-mode-disable": "hint.deemphasis",
      "output-dir-mode-workdir": "hint.baseDirectory",
      "output-dir-mode-manual": "hint.baseDirectory",
      "browse-output-directory": "hint.baseDirectory",
      "bitrate": "hint.bitrate",
      "sanitation": "hint.sanitation",
      "directory-scheme": "hint.directoryScheme",
      "track-scheme": "hint.trackScheme",
      "log-scheme": "hint.logScheme",
      "cue-scheme": "hint.cueScheme",
      "scheme-target-directory": "hint.directoryScheme",
      "scheme-target-track": "hint.trackScheme",
      "scheme-target-log": "hint.logScheme",
      "scheme-target-cue": "hint.cueScheme",
      "scheme-mode-auto": "hint.schemeMode",
      "scheme-mode-manual": "hint.schemeMode",
      "scheme-literal-input": "hint.schemeComposer",
      "enable-mb": "hint.enableMb",
      "enable-accurip": "hint.enableAccurateRip",
      "enable-coverart-db": "hint.enableCoverArtDb",
      "enable-embedding": "hint.enableEmbedding",
      "enable-replaygain": "hint.enableReplayGain",
      "eject-on-success": "hint.ejectOnSuccess",
      "cover-arts": "hint.coverArt",
      "coverart-lookup-size": "hint.coverArtSize",
      "output-directory-manual": "hint.baseDirectory",
    };

    Object.entries(hintMap).forEach(([id, key]) => {
      const target = el(id);
      if (!target) {
        return;
      }

      const label = target.closest("label");
      if (!label) {
        return;
      }

      if (label.querySelector(`.hint[data-tip-key='${key}']`)) {
        return;
      }

      const hint = document.createElement("span");
      hint.className = "hint inline";
      hint.tabIndex = -1;
      hint.dataset.tipKey = key;
      hint.dataset.tip = t(key);
      hint.textContent = "i";

      const head = label.querySelector(".label-head");
      if (head) {
        head.appendChild(hint);
        return;
      }

      const textSpan = label.querySelector("span");
      if (textSpan && textSpan.parentElement === label) {
        textSpan.insertAdjacentElement("afterend", hint);
      } else {
        label.appendChild(hint);
      }
    });
  }

  function wireHintViewportBehavior() {
    document.querySelectorAll(".hint").forEach((node) => {
      if (node.dataset.tipBound === "1") {
        return;
      }
      node.dataset.tipBound = "1";

      const align = () => {
        node.classList.remove("tip-left", "tip-right", "tip-up");
        node.style.removeProperty("--tip-width");
        const rect = node.getBoundingClientRect();
        const modalBody = node.closest("#settings-overlay .modal-body, #directory-picker-overlay .modal-body");

        const bounds = modalBody
          ? modalBody.getBoundingClientRect()
          : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };

        const margin = 12;
        const maxWidthByBounds = Math.max(180, Math.floor((bounds.right - bounds.left) * 0.88));
        const tipWidth = Math.min(340, Math.round(window.innerWidth * 0.74), maxWidthByBounds);
        node.style.setProperty("--tip-width", `${tipWidth}px`);

        const left = rect.left + rect.width / 2 - tipWidth / 2;
        const right = rect.left + rect.width / 2 + tipWidth / 2;
        if (left < bounds.left + margin) {
          node.classList.add("tip-left");
        } else if (right > bounds.right - margin) {
          node.classList.add("tip-right");
        }

        const estimatedTipHeight = 170;
        const spaceBelow = bounds.bottom - rect.bottom;
        const spaceAbove = rect.top - bounds.top;
        if (spaceBelow < estimatedTipHeight && spaceAbove > spaceBelow) {
          node.classList.add("tip-up");
        }
      };

      const clear = () => {
        node.classList.remove("tip-left", "tip-right", "tip-up");
        node.style.removeProperty("--tip-width");
      };

      node.addEventListener("mouseenter", align);
      node.addEventListener("mouseleave", clear);
      node.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      node.addEventListener("click", (event) => {
        event.preventDefault();
      });
    });
  }

  async function loadLocaleDictionary(locale) {
    try {
      const response = await fetch(`/static/i18n/${encodeURIComponent(locale)}.json`, { cache: "no-cache" });
      if (!response.ok) {
        return {};
      }
      const data = await response.json();
      return data && typeof data === "object" ? data : {};
    } catch (_) {
      return {};
    }
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.getAttribute("data-i18n");
      node.textContent = t(key);
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      const key = node.getAttribute("data-i18n-placeholder");
      node.placeholder = t(key);
    });

    document.querySelectorAll("[data-tip-key]").forEach((node) => {
      const key = node.getAttribute("data-tip-key");
      node.dataset.tip = t(key);
    });

    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      const key = node.getAttribute("data-i18n-title");
      node.title = t(key);
    });

    const langSelect = el("settings-language");
    if (langSelect) {
      Array.from(langSelect.options).forEach((option) => {
        option.textContent = t(`language.name.${option.value}`) || option.value;
      });
      langSelect.value = state.locale;
    }

    renderSchemeTokens();
    renderSchemeActiveSummary();
    renderActiveSchemeComposer();
    wireHintViewportBehavior();
  }

  function t(key, vars = null) {
    const fallback = lookupKey(state.fallbackDictionary, key);
    const current = lookupKey(state.dictionary, key);
    const base = current !== undefined ? current : fallback;
    const text = base === undefined ? key : String(base);

    if (!vars) {
      return text;
    }

    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, group) => {
      if (!(group in vars)) {
        return `{${group}}`;
      }
      return String(vars[group]);
    });
  }

  function lookupKey(dict, dottedKey) {
    if (!dict || typeof dict !== "object") {
      return undefined;
    }

    let current = dict;
    const parts = String(dottedKey).split(".");
    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  function parsePregapRules(rawText) {
    const rules = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const split = line.indexOf("=");
      if (split <= 0) {
        throw new Error(t("error.pregapFormat", { line: lineNumber }));
      }

      const trackPart = line.slice(0, split).trim();
      const actionPart = line.slice(split + 1).trim();

      if (!actionPart) {
        throw new Error(t("error.pregapActionMissing", { line: lineNumber }));
      }

      rules.push({
        track: parseInteger(trackPart, t("error.trackLabel")),
        action: actionPart,
      });
    });
    return rules;
  }

  function parseCoverArts(rawText) {
    const rows = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const split = line.indexOf("=");
      if (split < 0) {
        rows.push({ source: line.trim() });
        return;
      }

      const destination = line.slice(0, split).trim();
      const source = line.slice(split + 1).trim();
      if (!source) {
        throw new Error(t("error.coverArtIncomplete", { line: lineNumber }));
      }
      rows.push({ destination, source });
    });
    return rows;
  }

  function eachNonEmptyLine(rawText, callback) {
    const lines = String(rawText || "").split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      callback(trimmed, idx + 1);
    });
  }

  function parseInteger(rawValue, label) {
    const value = String(rawValue || "").trim();
    if (!/^-?\d+$/.test(value)) {
      throw new Error(t("error.integerLabel", { label }));
    }
    return Number.parseInt(value, 10);
  }

  function intOrNull(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) {
      return null;
    }
    return parseInteger(value, t("error.integer"));
  }

  function floatOrNull(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) {
      return null;
    }
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) {
      throw new Error(t("error.float", { value }));
    }
    return parsed;
  }

  function valueOrEmpty(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function normalizeOptionalInt(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const parsed = Number.parseInt(String(value), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function setMessage(id, message) {
    el(id).textContent = message || "";
  }

  function clearError() {
    setMessage("error-box", "");
  }

  function showError(message) {
    setMessage("error-box", message || "");
  }

  async function apiGet(url) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-cache",
    });
    return handleApiResponse(response);
  }

  async function apiPost(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    return handleApiResponse(response);
  }

  async function handleApiResponse(response) {
    const text = await response.text();
    let data = {};

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        if (!response.ok) {
          throw new Error(text);
        }
      }
    }

    if (!response.ok) {
      const message = data && data.error ? data.error : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    return data;
  }

  function setCookie(name, value, maxAgeSeconds = 31536000) {
    const encodedName = encodeURIComponent(name);
    const encodedValue = encodeURIComponent(value);
    if (maxAgeSeconds <= 0) {
      document.cookie = `${encodedName}=; Max-Age=0; Path=/; SameSite=Lax`;
      return;
    }
    document.cookie = `${encodedName}=${encodedValue}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`;
  }

  function getCookie(name) {
    const encodedName = encodeURIComponent(name);
    const parts = document.cookie ? document.cookie.split(";") : [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed.startsWith(`${encodedName}=`)) {
        continue;
      }
      return decodeURIComponent(trimmed.slice(encodedName.length + 1));
    }
    return null;
  }

  initialize();
})();
