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
  --distpath "${PYI_DIST_DIR}" \
  --workpath "${PYI_BUILD_DIR}" \
  --specpath "${BUILD_DIR}" \
  --name "${APP_ID}" \
  --add-data "${ROOT_DIR}/webui/templates:webui/templates" \
  --add-data "${ROOT_DIR}/webui/static:webui/static" \
  "${ROOT_DIR}/launcher.py"

mkdir -p "${APPDIR}/usr/bin"
BINARY_SRC="${PYI_DIST_DIR}/${APP_ID}"
if [[ -d "${BINARY_SRC}" && -x "${BINARY_SRC}/${APP_ID}" ]]; then
  BINARY_SRC="${BINARY_SRC}/${APP_ID}"
elif [[ -d "${BINARY_SRC}" ]]; then
  BINARY_CANDIDATE="$(find "${BINARY_SRC}" -maxdepth 1 -type f -perm -111 | head -n 1 || true)"
  if [[ -n "${BINARY_CANDIDATE}" ]]; then
    BINARY_SRC="${BINARY_CANDIDATE}"
  fi
fi
if [[ ! -x "${BINARY_SRC}" ]]; then
  echo "PyInstaller output binary not found: ${BINARY_SRC}"
  echo "Dist directory content:"
  ls -la "${PYI_DIST_DIR}" || true
  exit 1
fi
cp "${BINARY_SRC}" "${APPDIR}/usr/bin/${APP_ID}"
chmod +x "${APPDIR}/usr/bin/${APP_ID}"

cp "${ROOT_DIR}/packaging/${APP_ID}.desktop" "${APPDIR}/${APP_ID}.desktop"
cp "${ROOT_DIR}/packaging/${APP_ID}.svg" "${APPDIR}/${APP_ID}.svg"
ln -s "${APP_ID}.svg" "${APPDIR}/.DirIcon"

cat >"${APPDIR}/AppRun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
exec "${HERE}/usr/bin/cyanrip-webui" "$@"
EOF
chmod +x "${APPDIR}/AppRun"

appimagetool "${APPDIR}" "${OUT_DIR}/${APPIMAGE_NAME}"

echo "AppImage created: ${OUT_DIR}/${APPIMAGE_NAME}"
