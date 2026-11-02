# Zorya Code Explorer

Локальный MCP-сервер для навигации по TypeScript- и JavaScript-коду. Он использует рабочие файлы выбранного локального проекта как источник истины; если проект находится под Git, анализирует его текущий worktree. Сервер строит диаграммы и показывает исходники с диапазонами строк и хешами.

## Установи MCP в этот проект

Агенту можно отправить запрос:

> Установи MCP в этот проект из https://github.com/zoomplus/zorya-code-explorer

Это закрытый репозиторий с инструкциями и бинарным архивом релиза; TypeScript-исходники в него не входят. Пользователю нужен доступ по приглашению. Используй только уже настроенный доступ `gh`. Если локальная сессия не авторизована, остановись и попроси пользователя завершить интерактивный вход самостоятельно. Если авторизованная сессия не имеет доступа к репозиторию, попроси владельца выдать приглашение. Не запрашивай пароль, токен или код входа.

Инструкция ниже загружает архив v0.1.0 и сверяет его SHA-256 со значением `SHA256SUMS` из того же приватного тега. Каталог установки и временные загрузки находятся вне проекта. Нужны GitHub CLI `gh` с уже настроенным доступом, `tar`, Node.js 20.19 или новее с npm и средство проверки SHA-256.

### Linux

Запускай из целевого проекта. Команды сохраняют пробелы в путях:

```sh
set -eu
TARGET="$(pwd -P)"
DOWNLOAD="$(mktemp -d)"
INSTALL_ROOT="$HOME/.local/share/zorya-code-explorer/v0.1.0"
CHECKOUT="$INSTALL_ROOT/zorya-code-explorer-0.1.0"
ASSET="zorya-code-explorer-v0.1.0.tgz"
mkdir -p "$INSTALL_ROOT"
if [ -e "$CHECKOUT" ] || [ -L "$CHECKOUT" ]; then
  printf '%s\n' "Установка уже существует. Не распаковывай поверх неё; см. раздел о повторном использовании ниже." >&2
  exit 1
fi
gh release download v0.1.0 --repo zoomplus/zorya-code-explorer --pattern "$ASSET" --dir "$DOWNLOAD"
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/zoomplus/zorya-code-explorer/contents/SHA256SUMS?ref=v0.1.0' > "$DOWNLOAD/SHA256SUMS"
EXPECTED="$(awk -v name="$ASSET" '$2 == name { count++; hash=$1; if (NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-fA-F]+$/) bad=1 } END { if (count != 1 || bad) exit 1; print hash }' "$DOWNLOAD/SHA256SUMS")"
test -n "$EXPECTED"
printf '%s  %s\n' "$EXPECTED" "$DOWNLOAD/$ASSET" | sha256sum -c -
STAGING="$(mktemp -d "$INSTALL_ROOT/.stage-v0.1.0.XXXXXX")"
tar -xzf "$DOWNLOAD/$ASSET" -C "$STAGING"
STAGED_CHECKOUT="$STAGING/zorya-code-explorer-0.1.0"
test -d "$STAGED_CHECKOUT"
(cd "$STAGED_CHECKOUT" && npm ci --omit=dev --ignore-scripts)
if [ -e "$CHECKOUT" ] || [ -L "$CHECKOUT" ]; then
  printf '%s\n' "Каталог установки появился во время подготовки; ничего не перезаписано." >&2
  exit 1
fi
mv "$STAGED_CHECKOUT" "$CHECKOUT"
rmdir "$STAGING"
cd "$CHECKOUT"
node scripts/install.mjs --project "$TARGET"
```

### macOS

Выполни тот же сценарий из корня целевого проекта. Перед распаковкой замени команду проверки хеша на:

```sh
printf '%s  %s\n' "$EXPECTED" "$DOWNLOAD/$ASSET" | shasum -a 256 -c -
```

### Windows PowerShell

Запускай из корня целевого проекта:

```powershell
$ErrorActionPreference = 'Stop'
$Target = (Get-Location).Path
$Download = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Zorya\Code Explorer\v0.1.0'
$Checkout = Join-Path $InstallRoot 'zorya-code-explorer-0.1.0'
$Staging = Join-Path $InstallRoot ('.stage-v0.1.0-' + [guid]::NewGuid().ToString())
$Asset = 'zorya-code-explorer-v0.1.0.tgz'
New-Item -ItemType Directory -Force $Download, $InstallRoot | Out-Null
if (Test-Path -LiteralPath $Checkout -PathType Any) { throw 'Installation already exists. Do not extract over it; see verified reuse instructions below.' }
gh release download v0.1.0 --repo zoomplus/zorya-code-explorer --pattern $Asset --dir $Download
if ($LASTEXITCODE -ne 0) { throw 'Release download failed' }
$ChecksumText = gh api -H 'Accept: application/vnd.github.raw+json' 'repos/zoomplus/zorya-code-explorer/contents/SHA256SUMS?ref=v0.1.0'
if ($LASTEXITCODE -ne 0) { throw 'Could not read SHA256SUMS from the trusted tag' }
$ChecksumPath = Join-Path $Download 'SHA256SUMS'
Set-Content -Encoding ascii -Value $ChecksumText -Path $ChecksumPath
$AssetChecksumEntries = @(Get-Content $ChecksumPath | Where-Object { $_ -match '\s+zorya-code-explorer-v0\.1\.0\.tgz$' })
if ($AssetChecksumEntries.Count -ne 1 -or $AssetChecksumEntries[0] -notmatch '^[0-9a-fA-F]{64}\s+zorya-code-explorer-v0\.1\.0\.tgz$') { throw 'SHA256SUMS must contain exactly one valid 64-hex entry for the release archive' }
$Expected = $AssetChecksumEntries[0].Substring(0, 64).ToLowerInvariant()
$Actual = (Get-FileHash (Join-Path $Download $Asset) -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw 'SHA256 mismatch; do not extract or install the archive' }
New-Item -ItemType Directory -Path $Staging | Out-Null
tar -xzf (Join-Path $Download $Asset) -C $Staging
if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed' }
$StagedCheckout = Join-Path $Staging 'zorya-code-explorer-0.1.0'
if (-not (Test-Path -LiteralPath $StagedCheckout -PathType Container)) { throw 'Archive layout does not match the expected release directory' }
Push-Location $StagedCheckout
try {
  npm ci --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
} finally {
  Pop-Location
}
if (Test-Path -LiteralPath $Checkout -PathType Any) { throw 'Installation directory appeared during preparation; no files were overwritten' }
Move-Item -LiteralPath $StagedCheckout -Destination $Checkout
node (Join-Path $Checkout 'scripts/install.mjs') --project $Target
if ($LASTEXITCODE -ne 0) { throw 'Project MCP installation failed' }
```

Если `gh` не имеет доступа к приватному репозиторию, остановись и попроси владельца выдать приглашение. Не обходи проверку хеша, не распаковывай архив при несовпадении и не устанавливай непроверенную сборку. Релиз не требует клонировать исходный репозиторий и не требует запускать сборку из TypeScript. Установка сначала готовится в новом staging-каталоге; существующий каталог версии не перезаписывается.

Установщик добавляет проектную запись в `<проект>/.codex/config.toml`, использует Codex project cwd с безопасной проверкой каталога и сохраняет прочие параметры. Индекс и состояние сервера хранятся в отдельном пользовательском каталоге вне проекта. Установка не меняет глобальные настройки, `package.json` или зависимости целевого проекта. Пути к Node.js и checkout локальны для этой машины; при переносе на другую машину повтори установку из того же проверенного релиза.

Корень задаёт выбранный Codex-проект и его обычная проектная `.codex/config.toml`; наличие `.git` не обязательно.

### Повторное использование и повторная попытка

Не запускай начальную процедуру поверх существующего `<каталог-установки>/zorya-code-explorer-0.1.0` и никогда не удаляй или не очищай существующую папку автоматически. Для следующего проекта или повтора установщика скачай и проверь архив заново, распакуй его в отдельный пустой staging-каталог и сравни все упакованные пути и байты с существующим checkout. Игнорируй только `node_modules`, созданный `npm ci`; любое недостающее, изменённое или неожиданное содержимое за его пределами означает отказ от повторного использования. При несовпадении оставь старый каталог нетронутым и запроси владельца. При совпадении запускай только `node <проверенный-checkout>/scripts/install.mjs --project <новый-абсолютный-путь>`: установщик идемпотентно добавляет или подтверждает проектную запись.

## Разрешение и проверка

Без внешнего operator config сервер запускается только с правом `read`. После установки отдельно разреши клиенту читать проектную MCP-конфигурацию и отдельно ответь на запрос доверия к серверу, если он появится. Это два самостоятельных решения; не включай автоматическое одобрение инструментов. Начни новый чат, чтобы клиент перечитал конфигурацию.

Через реальный MCP-клиент проверь handshake, `tools/list`, затем `explorer_open` в точном целевом проекте. Убедись, что кадр указывает этот проект; передай уникальный `conversationId` и вызови `explorer_source` для сущности, выбранной из полученного кадра. Установка завершена только после успешного чтения реального исходника. Если вызов не проходит, сохрани точный код ошибки и исправь подключение; не утверждай, что MCP готов.

### Одновременные подключения

Инициализация и обнаружение инструментов могут идти одновременно. Если один процесс владеет локальной БД workspace, а второй пытается анализировать ту же папку, второй может получить `workspace_busy`: заверши или закрой первую MCP-сессию и повтори запрос; не удаляй lock вручную. Разные проекты используют отдельное состояние и остаются изолированными.

Для записи и проверок нужен operator config владельца вне целевого проекта. Например, для TypeScript-проекта, где `npm run typecheck` уже работает:

```json
{
  "stdio": {
    "principalId": "local",
    "grants": ["read", "write", "validate", "publish"]
  },
  "checkProfiles": [
    {
      "id": "typecheck",
      "executable": "/usr/bin/npm",
      "args": ["run", "typecheck"],
      "timeoutMs": 120000
    }
  ]
}
```

Сохрани его вне проекта, например в `~/.config/zorya-code-explorer/operator.json`; замени `/usr/bin/npm` на абсолютный путь к `npm` в своей Linux-системе. Профиль должен точно соответствовать проекту и работать из staging-копии. Указывай только необходимые grants и команды. При первой установке замени последнюю команду из Linux-блока на:

```sh
node scripts/install.mjs --project "$TARGET" --config "$HOME/.config/zorya-code-explorer/operator.json"
```

Не добавляй config в репозиторий проекта.

Внешний поиск настраивается отдельно. Embeddings и reranking выключены по умолчанию; при явном подключении внешнего провайдера ему передаются кодовые фрагменты и запросы.

## Возможности и границы

- Обзор проекта, навигация по кадрам, чтение привязанных к снимку исходников, ограниченный граф потока управления и отчёты о ссылках и тестах.
- Лексический локальный поиск включён по умолчанию. Неизменённые индексированные фрагменты повторно используются при обновлении.
- Структурный анализ предназначен для TypeScript и JavaScript. Лексический поиск может покрывать и другие поддерживаемые текстовые файлы. Статические связи не доказывают runtime-поведение или полноту динамических зависимостей. Неподдерживаемые конструкции и пропуски покрытия должны оставаться видимыми.
- Если файлы изменились после построения кадра, `source_changed` или stale состояние требуют обновить индекс и выбрать сущность заново.
- MCP-транспорт локальный `stdio`; облачного сервера и HTTP-шлюза нет.

## Ограничения распространения

Дистрибутив предназначен приглашённым пользователям частного репозитория. Он содержит install-документы и архив релиза, но не TypeScript-исходники, исходную историю или исходный Git checkout. Скомпилированный JavaScript всё равно можно копировать или изучать; упаковка не является техническим запретом копирования.

Метаданные пакета `UNLICENSED` сохранены. Распространение ограничено приглашёнными пользователями частного репозитория.

Переиспользуемый запрос о локальной адаптации других MCP-серверов находится в [docs/reuse-prompt.md](docs/reuse-prompt.md).
