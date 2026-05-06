#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build/appimage"
VENV_DIR="${BUILD_DIR}/venv"
PYI_DIST_DIR="${BUILD_DIR}/dist"
PYI_BUILD_DIR="${BUILD_DIR}/pyinstaller"
APPDIR="${BUILD_DIR}/AppDir"
OUT_DIR="${ROOT_DIR}/dist"

APP_ID="cyanrip-webui"
APPIMAGE_NAME="${APP_ID}-x86_64.AppImage"

mkdir -p "${BUILD_DIR}" "${OUT_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found"
  exit 1
fi

if ! command -v appimagetool >/dev/null 2>&1; then
  echo "appimagetool not found in PATH"
  echo "Install appimagetool and re-run this script."
  exit 1
fi

rm -rf "${VENV_DIR}" "${PYI_DIST_DIR}" "${PYI_BUILD_DIR}" "${APPDIR}"
python3 -m venv "${VENV_DIR}"
source "${VENV_DIR}/bin/activate"
python3 -m pip install --upgrade pip
python3 -m pip install -r "${ROOT_DIR}/requirements.txt" pyinstaller

pyinstaller \
  --noconfirm \
  --clean \
  --onedir \
  --distpath "${PYI_DIST_DIR}" \
  --workpath "${PYI_BUILD_DIR}" \
  --specpath "${BUILD_DIR}" \
  --name "${APP_ID}" \
  --collect-submodules flask_sock \
  --collect-submodules simple_websocket \
  --collect-submodules wsproto \
  --collect-submodules pystray \
  --collect-submodules PIL \
  --collect-all PySide6 \
  --add-data "${ROOT_DIR}/webui/templates:webui/templates" \
  --add-data "${ROOT_DIR}/webui/static:webui/static" \
  --add-data "${ROOT_DIR}/packaging:packaging" \
  "${ROOT_DIR}/launcher.py"

RUNTIME_SRC_DIR="${PYI_DIST_DIR}/${APP_ID}"
if [[ ! -d "${RUNTIME_SRC_DIR}" ]]; then
  echo "PyInstaller output directory not found: ${RUNTIME_SRC_DIR}"
  echo "Dist directory content:"
  ls -la "${PYI_DIST_DIR}" || true
  exit 1
fi

RUNTIME_DST_DIR="${APPDIR}/usr/lib/${APP_ID}"
mkdir -p "${APPDIR}/usr/bin" "${RUNTIME_DST_DIR}" "${APPDIR}/usr/share/applications" "${APPDIR}/usr/share/icons/hicolor/scalable/apps"
cp -a "${RUNTIME_SRC_DIR}/." "${RUNTIME_DST_DIR}/"

if [[ ! -x "${ROOT_DIR}/bin/cyanrip" ]]; then
  echo "Bundled cyanrip binary missing or not executable: ${ROOT_DIR}/bin/cyanrip"
  exit 1
fi
cp "${ROOT_DIR}/bin/cyanrip" "${APPDIR}/usr/bin/cyanrip"
chmod +x "${APPDIR}/usr/bin/cyanrip"

RUNTIME_BIN="${RUNTIME_DST_DIR}/${APP_ID}"
if [[ ! -x "${RUNTIME_BIN}" ]]; then
  RUNTIME_BIN_CANDIDATE="$(find "${RUNTIME_DST_DIR}" -maxdepth 1 -type f -perm -111 | head -n 1 || true)"
  if [[ -n "${RUNTIME_BIN_CANDIDATE}" ]]; then
    RUNTIME_BIN="${RUNTIME_BIN_CANDIDATE}"
  fi
fi
if [[ ! -x "${RUNTIME_BIN}" ]]; then
  echo "PyInstaller runtime binary not found in ${RUNTIME_DST_DIR}"
  ls -la "${RUNTIME_DST_DIR}" || true
  exit 1
fi

cat >"${APPDIR}/usr/bin/${APP_ID}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
HERE="\$(dirname "\$(readlink -f "\$0")")"
exec "\${HERE}/../lib/${APP_ID}/$(basename "${RUNTIME_BIN}")" "\$@"
EOF
chmod +x "${APPDIR}/usr/bin/${APP_ID}"

cp "${ROOT_DIR}/packaging/${APP_ID}.desktop" "${APPDIR}/${APP_ID}.desktop"
cp "${ROOT_DIR}/packaging/${APP_ID}.desktop" "${APPDIR}/usr/share/applications/${APP_ID}.desktop"
cp "${ROOT_DIR}/packaging/${APP_ID}.svg" "${APPDIR}/${APP_ID}.svg"
cp "${ROOT_DIR}/packaging/${APP_ID}.svg" "${APPDIR}/usr/share/icons/hicolor/scalable/apps/${APP_ID}.svg"
ln -s "${APP_ID}.svg" "${APPDIR}/.DirIcon"

cat >"${APPDIR}/AppRun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
export CYANRIP_WEBUI_APPDIR="${HERE}"
export CYANRIP_WEBUI_BUNDLED_CYANRIP="${HERE}/usr/bin/cyanrip"
export CYANRIP_WEBUI_ICON="${HERE}/usr/share/icons/hicolor/scalable/apps/cyanrip-webui.svg"
if [[ -n "${APPIMAGE:-}" ]]; then
  APPIMAGE_DIR="$(dirname "$(readlink -f "${APPIMAGE}")")"
else
  APPIMAGE_DIR="${HERE}"
fi
export CYANRIP_WEBUI_DEFAULT_OUTPUT_DIR="${APPIMAGE_DIR}/output"
exec "${HERE}/usr/bin/cyanrip-webui" "$@"
EOF
chmod +x "${APPDIR}/AppRun"

appimagetool "${APPDIR}" "${OUT_DIR}/${APPIMAGE_NAME}"

echo "AppImage created: ${OUT_DIR}/${APPIMAGE_NAME}"
