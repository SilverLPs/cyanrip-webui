(() => {
  const defaults = window.CYANRIP_DEFAULTS || {};
  const outputs = window.CYANRIP_OUTPUTS || [];
  const sanitationModes = window.CYANRIP_SANITATION || [];
  const coverSizes = window.CYANRIP_COVERART_SIZES || [];

  const state = {
    previewTimer: null,
    currentJobId: null,
    nextLogIndex: null,
  };

  const el = (id) => document.getElementById(id);

  function initialize() {
    renderOutputCheckboxes();
    renderSelectOptions("sanitation", sanitationModes);
    renderSelectOptions("coverart-lookup-size", coverSizes.map(String));
    applyDefaults();
    wireEvents();

    refreshPreview();
    refreshStatusAndLogs();
    setInterval(refreshStatusAndLogs, 1500);
  }

  function renderOutputCheckboxes() {
    const container = el("outputs-container");
    container.innerHTML = "";

    outputs.forEach((output) => {
      const wrapper = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = output;
      checkbox.dataset.role = "output";
      wrapper.append(checkbox, document.createTextNode(output));
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
    el("device-path").value = defaults.device_path || "";
    el("offset").value = defaults.offset ?? 0;
    el("max-retries").value = defaults.max_retries ?? 10;
    el("ripping-retries").value = valueOrEmpty(defaults.ripping_retries);
    el("speed").value = valueOrEmpty(defaults.speed);
    el("paranoia-level").value = defaults.paranoia_level || "max";

    el("overread-leadinout").checked = !!defaults.overread_leadinout;
    el("decode-hdcd").checked = !!defaults.decode_hdcd;
    el("force-deemphasis").checked = !!defaults.force_deemphasis;
    el("disable-deemphasis").checked = !!defaults.disable_deemphasis;
    el("disable-replaygain").checked = !!defaults.disable_replaygain;
    el("find-drive-offset").checked = !!defaults.find_drive_offset;

    el("bitrate").value = defaults.bitrate ?? 256;
    el("directory-scheme").value = defaults.directory_scheme || "";
    el("track-scheme").value = defaults.track_scheme || "";
    el("log-scheme").value = defaults.log_scheme || "";
    el("cue-scheme").value = defaults.cue_scheme || "";
    el("track-selection").value = (defaults.track_selection || []).join(",");
    el("sanitation").value = defaults.sanitation || "unicode";

    el("print-info-only").checked = !!defaults.print_info_only;
    el("disable-mb").checked = !!defaults.disable_mb;
    el("disable-accurip").checked = !!defaults.disable_accurip;
    el("disable-coverart-db").checked = !!defaults.disable_coverart_db;
    el("disable-coverart-embedding").checked = !!defaults.disable_coverart_embedding;
    el("eject-on-success").checked = !!defaults.eject_on_success;
    el("print-version").checked = !!defaults.print_version;
    el("show-help").checked = !!defaults.show_help;

    el("album-metadata").value = defaults.album_metadata || "";
    el("track-metadata").value = "";
    el("release").value = defaults.release || "";
    el("disc-number").value = valueOrEmpty(defaults.disc_number);
    el("total-discs").value = valueOrEmpty(defaults.total_discs);
    el("cover-arts").value = "";
    el("coverart-lookup-size").value = String(defaults.coverart_lookup_size ?? -1);

    const selected = new Set(defaults.outputs || ["flac"]);
    document.querySelectorAll("input[data-role='output']").forEach((node) => {
      node.checked = selected.has(node.value);
    });
  }

  function wireEvents() {
    el("probe-binary").addEventListener("click", probeBinary);
    el("refresh-preview").addEventListener("click", refreshPreview);
    el("start-job").addEventListener("click", startJob);
    el("stop-job").addEventListener("click", stopJob);

    document.querySelectorAll("input,select,textarea").forEach((node) => {
      node.addEventListener("input", debouncePreview);
      node.addEventListener("change", debouncePreview);
    });
  }

  function debouncePreview() {
    if (state.previewTimer !== null) {
      window.clearTimeout(state.previewTimer);
    }
    state.previewTimer = window.setTimeout(refreshPreview, 260);
  }

  async function probeBinary() {
    clearError();
    setMessage("probe-result", "Pruefe Binary...");

    try {
      const body = {
        binary_path: el("binary-path").value.trim(),
      };
      const result = await apiPost("/api/probe", body);
      const lines = [];
      lines.push(`-V rc=${result.version_returncode}`);
      lines.push(result.version_output || "<keine Ausgabe>");
      lines.push("");
      lines.push(`-h rc=${result.help_returncode}`);
      lines.push(result.help_preview || "<keine Ausgabe>");
      setMessage("probe-result", lines.join("\n"));
    } catch (err) {
      showError(err.message);
      setMessage("probe-result", "");
    }
  }

  async function refreshPreview() {
    clearError();
    try {
      const payload = {
        binary_path: el("binary-path").value.trim(),
        config: collectConfig(),
      };
      const preview = await apiPost("/api/preview", payload);
      el("command-preview").textContent = preview.shell_command || "";
    } catch (err) {
      showError(err.message);
      el("command-preview").textContent = "";
    }
  }

  async function startJob() {
    clearError();
    try {
      const payload = {
        binary_path: el("binary-path").value.trim(),
        working_directory: el("working-directory").value.trim(),
        config: collectConfig(),
      };
      const snapshot = await apiPost("/api/start", payload);
      if (snapshot.job_id !== state.currentJobId) {
        state.currentJobId = snapshot.job_id;
        state.nextLogIndex = null;
        el("job-log").textContent = "";
      }
      await refreshStatusAndLogs();
    } catch (err) {
      showError(err.message);
    }
  }

  async function stopJob() {
    clearError();
    try {
      await apiPost("/api/stop", {});
      await refreshStatusAndLogs();
    } catch (err) {
      showError(err.message);
    }
  }

  async function refreshStatusAndLogs() {
    try {
      const status = await apiGet("/api/status");
      updateStatus(status);

      if (status.job_id !== state.currentJobId) {
        state.currentJobId = status.job_id;
        state.nextLogIndex = null;
        el("job-log").textContent = "";
      }

      if (status.log_oldest_index !== undefined && status.log_oldest_index !== null) {
        if (state.nextLogIndex === null) {
          state.nextLogIndex = status.log_oldest_index;
        }
      }

      const since = state.nextLogIndex ?? 0;
      const logs = await apiGet(`/api/logs?since=${encodeURIComponent(String(since))}`);
      appendLogs(logs.lines || []);
      state.nextLogIndex = logs.next_index;
    } catch (err) {
      showError(err.message);
    }
  }

  function updateStatus(status) {
    el("status-state").textContent = status.state || "unknown";
    if (status.returncode === null || status.returncode === undefined) {
      el("status-returncode").textContent = "Exit: -";
    } else {
      el("status-returncode").textContent = `Exit: ${status.returncode}`;
    }
  }

  function appendLogs(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }

    const log = el("job-log");
    const parts = lines.map((entry) => {
      const index = entry.index ?? "?";
      const text = entry.line ?? "";
      return `[${index}] ${text}`;
    });

    const tail = parts.join("\n") + "\n";
    log.textContent += tail;
    log.scrollTop = log.scrollHeight;
  }

  function collectConfig() {
    return {
      device_path: el("device-path").value.trim(),
      offset: intOrNull(el("offset").value),
      max_retries: intOrNull(el("max-retries").value),
      ripping_retries: intOrNull(el("ripping-retries").value),
      speed: intOrNull(el("speed").value),
      pregap_rules: parsePregapRules(el("pregap-rules").value),
      paranoia_level: el("paranoia-level").value.trim() || null,
      overread_leadinout: el("overread-leadinout").checked,
      decode_hdcd: el("decode-hdcd").checked,
      force_deemphasis: el("force-deemphasis").checked,
      disable_deemphasis: el("disable-deemphasis").checked,
      disable_replaygain: el("disable-replaygain").checked,
      outputs: getSelectedOutputs(),
      bitrate: floatOrNull(el("bitrate").value),
      directory_scheme: el("directory-scheme").value,
      track_scheme: el("track-scheme").value,
      log_scheme: el("log-scheme").value,
      cue_scheme: el("cue-scheme").value,
      track_selection: parseTrackSelection(el("track-selection").value),
      sanitation: el("sanitation").value,
      print_info_only: el("print-info-only").checked,
      album_metadata: el("album-metadata").value.trim(),
      track_metadata: parseTrackMetadata(el("track-metadata").value),
      release: el("release").value.trim(),
      disc_number: intOrNull(el("disc-number").value),
      total_discs: intOrNull(el("total-discs").value),
      cover_arts: parseCoverArts(el("cover-arts").value),
      disable_mb: el("disable-mb").checked,
      disable_accurip: el("disable-accurip").checked,
      disable_coverart_db: el("disable-coverart-db").checked,
      coverart_lookup_size: intOrNull(el("coverart-lookup-size").value),
      disable_coverart_embedding: el("disable-coverart-embedding").checked,
      eject_on_success: el("eject-on-success").checked,
      find_drive_offset: el("find-drive-offset").checked,
      print_version: el("print-version").checked,
      show_help: el("show-help").checked,
    };
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

  function parsePregapRules(rawText) {
    const rules = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const parts = line.split("=");
      if (parts.length !== 2) {
        throw new Error(`Pregap-Regel in Zeile ${lineNumber} muss track=action sein.`);
      }
      const track = toInt(parts[0].trim(), `Pregap-Track Zeile ${lineNumber}`);
      const action = parts[1].trim();
      if (!action) {
        throw new Error(`Pregap-Action in Zeile ${lineNumber} fehlt.`);
      }
      rules.push({ track, action });
    });
    return rules;
  }

  function parseTrackMetadata(rawText) {
    const entries = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const equalsPos = line.indexOf("=");
      if (equalsPos <= 0 || equalsPos === line.length - 1) {
        throw new Error(`Track-Metadaten in Zeile ${lineNumber} muessen track=metadata sein.`);
      }
      const trackRaw = line.slice(0, equalsPos).trim();
      const metadata = line.slice(equalsPos + 1).trim();
      const track = toInt(trackRaw, `Track-Metadaten Zeile ${lineNumber}`);
      entries.push({ track, metadata });
    });
    return entries;
  }

  function parseCoverArts(rawText) {
    const entries = [];
    eachNonEmptyLine(rawText, (line, lineNumber) => {
      const equalsPos = line.indexOf("=");
      if (equalsPos < 0) {
        entries.push({ source: line.trim() });
        return;
      }

      if (equalsPos === 0 || equalsPos === line.length - 1) {
        throw new Error(`Cover-Art in Zeile ${lineNumber} muss destination=source sein.`);
      }

      const left = line.slice(0, equalsPos).trim();
      const right = line.slice(equalsPos + 1).trim();
      if (!left || !right) {
        throw new Error(`Cover-Art in Zeile ${lineNumber} ist unvollstaendig.`);
      }

      if (looksLikeCoverDestination(left)) {
        entries.push({ destination: left, source: right });
      } else {
        entries.push({ source: line.trim() });
      }
    });
    return entries;
  }

  function looksLikeCoverDestination(raw) {
    if (/^\d+$/.test(raw)) {
      return true;
    }
    return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(raw);
  }

  function parseTrackSelection(rawText) {
    if (!rawText || !rawText.trim()) {
      return [];
    }
    return rawText
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, index) => toInt(part, `Trackliste Element ${index + 1}`));
  }

  function eachNonEmptyLine(rawText, callback) {
    const lines = String(rawText || "").split(/\r?\n/);
    lines.forEach((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }
      callback(line, idx + 1);
    });
  }

  function intOrNull(value) {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    return toInt(text, "Zahl");
  }

  function floatOrNull(value) {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    const parsed = Number.parseFloat(text);
    if (Number.isNaN(parsed)) {
      throw new Error(`Ungueltige Kommazahl: ${text}`);
    }
    return parsed;
  }

  function toInt(raw, label) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`${label} ist keine gueltige Ganzzahl.`);
    }
    return parsed;
  }

  function valueOrEmpty(value) {
    return value === null || value === undefined ? "" : value;
  }

  async function apiPost(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return parseApiResponse(response);
  }

  async function apiGet(url) {
    const response = await fetch(url);
    return parseApiResponse(response);
  }

  async function parseApiResponse(response) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return {};
    }

    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  function showError(message) {
    el("error-box").textContent = message || "";
  }

  function clearError() {
    showError("");
  }

  function setMessage(id, message) {
    el(id).textContent = message || "";
  }

  initialize();
})();
