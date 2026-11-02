# Windows EXE

Версия 0.6.0 включает BCC-style Chroma Key Studio (WebGL2 preview и многоступенчатый FFmpeg matte cleanup), многодорожечный таймлайн, нарезку и тримминг сегментов, отделение аудио и микшер. Собирается для Windows x64 в два файла:

- `release/AutoClippingUpgrader-0.6.0-Setup-x64.exe` — установщик с выбором папки и ярлыком. Установка выполняется для текущего пользователя; установщик не запускает приложение автоматически по завершении.
- `release/AutoClippingUpgrader-0.6.0-Portable-x64.exe` — один EXE, запускаемый без установки. Настройки и черновик сохраняются в пользовательском профиле, а не рядом с EXE.

Обе сборки содержат Electron, встроенный Node runtime, FFmpeg 9.0.2, FFprobe и локальную AI-модель. Отдельные Node.js, npm и запись FFmpeg в PATH пользователю не нужны. NVIDIA-драйвер нужен только для NVENC; при недоступном NVENC приложение может использовать CPU fallback.

Это локальная сборка без цифровой подписи Authenticode. Публичная публикация и автоматическое обновление не выполняются. SHA-256 созданных EXE записывается в `release/SHA256SUMS.txt`.

## Настройки аккаунтов

Во вкладке «Публикация» отображается полный путь к файлу настроек. В установленной или portable версии это `oauth.env` в Electron userData (обычно `%APPDATA%/AutoClippingUpgrader/`). Кнопка «Открыть папку настроек» создаёт пустой образец, если файла ещё нет, и открывает папку. Уже существующие реквизиты она не перезаписывает.

Заполните параметры TikTok / Google в этом файле и перезапустите приложение. Реальные client secrets не включаются в EXE. Подробнее: [publishing.md](publishing.md).

## Повторная сборка из исходников

Нужны Windows, Node.js >=22.12, установленные зависимости проекта и сборка FFmpeg с лицензией и информацией о происхождении. По умолчанию используется `.tools/ffmpeg-9.0.2-essentials_build`:

```powershell
.\scripts\run.ps1 prepare:ai
.\scripts\run.ps1 dist:win
```

Для другого расположения комплекта FFmpeg:

```powershell
$env:ACU_FFMPEG_BUNDLE_DIR = 'D:\Tools\ffmpeg-9.0.2-essentials_build'
.\scripts\run.ps1 dist:win
```

Комплект должен содержать `bin/ffmpeg.exe`, `bin/ffprobe.exe`, `LICENSE` и `README.txt`. Указание произвольного нового комплекта требует актуализации сведений о его версии/лицензии в `build/THIRD-PARTY-NOTICES.md`.

Процесс:

1. TypeScript-проверка и Vite-сборка renderer/main/preload. Runtime-зависимости main, включая Zod, включаются в bundle.
2. Создание отдельной staging-папки с минимальным package.json и готовыми dist-файлами. `node_modules`, `.env`, тесты, исходные ролики и пользовательский кэш не включаются в приложение.
3. electron-builder 26 упаковывает приложение в ASAR. FFmpeg и FFprobe копируются в `resources/ffmpeg` вне ASAR, чтобы выполняться обычными дочерними процессами.
4. Создаются NSIS installer, portable EXE и checksums. Лицензии Electron/Chromium и используемых библиотек, оригинальная GPLv3-лицензия FFmpeg и информация о сборке включаются в комплект.

Конфигурация: `scripts/package-win.cjs`. Значок: `build/icon.svg`, `icon.png`, `icon.ico`. Исполняемые файлы приложения получают имя и значок AutoClippingUpgrader. Автопоиск сертификатов и публикация отключены явно; приватный сертификат не требуется для локальной сборки.

## Проверка готовых EXE

```powershell
.\scripts\run.ps1 test:package
```

Тест проверяет ASAR, отсутствие dev-файлов/секретов, комплект executables/лицензий и PE-заголовок установщика. Затем запускает реальный `win-unpacked/AutoClippingUpgrader.exe` и portable EXE без отображения окна, с отдельным временным профилем и PATH только из системных Windows-каталогов.

В каждом запущенном EXE тест открывает редактор, создаёт настоящую тестовую видеозапись через встроенный FFmpeg, получает метаданные через встроенный FFprobe, декодирует источник, создаёт шесть кадров и точный PNG-композит. Проверяются версия внутри ASAR и интерфейса, многодорожечные split/gain/detach, настоящая waveform, sandbox renderer и штатное закрытие с сохранением сегментов в черновике. Скриншоты и результат сохраняются в `out/package-qa/`.

Сам установщик не устанавливается в пользовательскую систему во время теста: его сборка проверяется отдельно, а приложение исполняется из unpacked-комплекта и portable EXE. Облачные публикации тест не запускает.

`--user-data-dir=<absolute path>` позволяет выбрать отдельный профиль. `--hidden` используется только для технических проверок без видимого окна; обычный запуск EXE показывает редактор.

Опорные источники: [electron-builder Windows configuration](https://www.electron.build/v26/docs/win/), [NSIS / Portable](https://www.electron.build/v26/docs/nsis/), [ASAR и extraResources](https://www.electron.build/v26/docs/contents/).

Модель IMG.LY 1.7.0 подготавливается командой `prepare:ai`: при отсутствии кэша загружается официальный архив, выбранные quantized ISNET/WASM-ресурсы копируются в `build/ai-assets`. В EXE они находятся в `resources/ai-assets`; интернет для удаления фона не нужен. `test:package` выполняет настоящее ONNX inference с заблокированными HTTP/HTTPS-запросами в unpacked и portable версиях.
