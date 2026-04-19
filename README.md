# cyanrip-webui

WebUI fuer `cyanrip` auf Linux. Das Projekt nutzt `cyanrip` unveraendert als externe CLI-Binary und baut nur eine grafische Steuer- und Anzeigeebene darum herum.

## Ziele

- Keine Aenderungen am `cyanrip`-Sourcecode (`cyanrip-src-v0.9.3.1` bleibt read-only Referenz)
- Lose Kopplung: WebUI arbeitet nur ueber CLI-Argumente und Prozessausgabe
- Moeglichst wenige Dependencies (nur Flask + Python-Stdlib)
- Vollstaendige Flag-Abdeckung der Cyanrip-CLI

## Projektstruktur

- `app.py`: Flask-Entrypoint
- `webui/app_factory.py`: Routen und API
- `webui/command_builder.py`: Mapping UI-Daten -> cyanrip CLI
- `webui/runner.py`: Start/Stop und Log-Streaming fuer laufende Jobs
- `webui/templates/index.html`: Single-Page UI
- `webui/static/style.css`, `webui/static/app.js`: Frontend
- `tests/test_command_builder.py`: Unit-Tests fuer Argument-Building

## Schnellstart

1. Python venv erstellen und aktivieren.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Cyanrip-Binary bereitstellen, z. B.:

```bash
mkdir -p bin
cp /usr/bin/cyanrip ./bin/cyanrip
chmod +x ./bin/cyanrip
```

3. WebUI starten:

```bash
python app.py
```

4. Browser oeffnen: `http://127.0.0.1:8080`

## API-Endpunkte

- `POST /api/preview`: Command aus UI-Daten bauen
- `POST /api/start`: Rip-Job starten
- `POST /api/stop`: laufenden Job stoppen
- `GET /api/status`: Job-Status
- `GET /api/logs?since=<index>`: inkrementelle Logs
- `POST /api/probe`: `-V`/`-h` gegen Binary pruefen

## Hinweise

- `working_directory` bestimmt, von wo aus cyanrip gestartet wird.
- Mehrfachoptionen (`-t`, `-p`, `-C`) werden ueber zeilenbasierte Eingaben in der UI abgebildet.
- Aktuell auf Linux ausgerichtet; Plattformabhaengigkeiten wurden auf minimale Dateipfade/Prozesssteuerung begrenzt.

## Tests

```bash
python3 -m unittest discover -s tests
```
