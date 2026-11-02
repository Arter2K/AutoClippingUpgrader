# AutoClippingUpgrader — desktop video editor

Electron + React + TypeScript приложение для вертикального монтажа: многодорожечный таймлайн, нарезка и тримминг сегментов, отделение аудио, микшер, JSON-шаблоны, BCC-style Chroma Key Studio, локальное AI-удаление фона и FFmpeg-рендер. Готовое видео передаётся в панель публикации TikTok / Google Drive; Drive при выбранной опции загружается после рендера.

**Текущая версия: 0.7.0.** Локальная Windows-сборка создаёт `release/AutoClippingUpgrader-0.7.0-Setup-x64.exe` и `release/AutoClippingUpgrader-0.7.0-Portable-x64.exe` со встроенными FFmpeg/FFprobe и AI-моделью. Готовые EXE, модели, `node_modules` и тестовые артефакты не хранятся в Git. [Инструкция EXE и повторная сборка](docs/windows-build.md).

**Запуск из исходников:** после установки зависимостей и сборки откройте `Start.cmd` либо выполните `.\scripts\run.ps1 preview`. Для разработки используйте `npm run dev`. [Руководство редактора](docs/editor.md) содержит описание функций, горячих клавиш и проверки; артефакты локальных проверок создаются в `out/`.

**Монтаж и эффекты:** [многодорожечный таймлайн](docs/multitrack-timeline.md), [BCC-style Chroma Key Studio](docs/bcc-chroma-key.md), [текст, анимации и AI matting](docs/layer-effects.md).

**Проекты `.acup`:** сохранение и «Сохранить как», открытие старых `.acu.json`, импорт самостоятельной копии и [экспорт с медиа для переноса](docs/projects.md). Экспорт создаёт `.acup` и соседнюю папку ресурсов; переносите их вместе.

**Настройка шага 2:** [docs/publishing.md](docs/publishing.md) и [.env.example](.env.example). Для входа нужны реквизиты ваших OAuth-приложений. Реальные облачные аккаунты при разработке не использовались; протоколы проверены управляемыми сетевыми тестами, native Electron и настоящими файловыми потоками.

## Запуск

Node.js >= 22.12, npm или pnpm 11, FFmpeg **7+** и FFprobe из одной сборки. Нужны фильтры `ass`, `chromakey`, `colorkey`, `despill`, `drawtext`, `boxblur`, `overlay`, `loudnorm` и кодеки `libx264`/`libx265`; NVENC дополнительно требует совместимые GPU и драйвер. Проверка выполнена на Windows с FFmpeg 9.0.2.

```powershell
npm install
npm run prepare:ai
$env:FFMPEG_PATH = 'C:\ffmpeg\bin\ffmpeg.exe'
$env:FFPROBE_PATH = 'C:\ffmpeg\bin\ffprobe.exe'
npm run dev
```

Если FFmpeg/FFprobe находятся в PATH, переменные не нужны. В текущей рабочей папке локальная проверочная сборка находится в `.tools/ffmpeg-9.0.2-essentials_build/bin`. Вспомогательный скрипт автоматически подхватывает её и поддерживает доступный в этом окружении pnpm:

```powershell
.\scripts\run.ps1 dev
.\scripts\run.ps1 build
.\scripts\run.ps1 test
.\scripts\run.ps1 test:integration
```

Рендер своего файла:

```powershell
.\scripts\run.ps1 engine --template templates/clean-vertical.json --input 'D:\Video\clip.mp4' --output 'D:\Video\vertical.mp4' --in 2.1 --out 12.1
```

При обычном npm: `npm run engine -- --template ... --input ... --output ... --in 2.1 --out 12.1`.

План без рендера: добавьте `--plan-dir out/plan`. CLI прочитает метаданные, проверит шаблон и сохранит `plan.json`, `filter.ffgraph`, caption-файлы и копии шрифтов. `commands[].args` запускаются последовательно через `spawn(ffmpeg, args, { cwd: planDir, shell: false })`. Папка плана должна быть отдельной для каждой задачи. JSON argv — источник истины, склеивать его в shell-строку не следует.

Синтетический демонстрационный рендер 1080×1920 / 60 fps:

```powershell
.\scripts\run.ps1 demo
```

Результаты: `out/demo/synthetic-source.mp4`, `vertical-1080p60.mp4`, `probe.json`, `render-plan.json`. Повторный запуск требует нового имени или удаления только своих предыдущих demo-файлов: существующие видео приложение не перезаписывает.

## Структура движка шага 1

```text
montage/
├── src/
│   ├── main/
│   │   ├── index.ts                Electron, выбор файла, проверка IPC-отправителя
│   │   └── engine/
│   │       ├── graph.ts            Единый граф, слои, фон, текст, тайминги
│   │       ├── encoding.ts         NVENC/x264/x265 и режимы битрейта
│   │       ├── plan.ts             Валидация задания и последовательность команд
│   │       ├── renderer.ts         NVENC preflight, fallback, файлы, отмена
│   │       ├── probe.ts            Длительность, размеры, звук, поворот
│   │       ├── process.ts          spawn без shell, ограниченный хвост логов
│   │       └── progress.ts         Парсер stdout и stderr по частичным строкам
│   ├── preload/index.ts            Узкий contextBridge API
│   ├── shared/
│   │   ├── template.ts             Zod-схема + выведенные TypeScript-типы
│   │   ├── estimate.ts             Чистая функция для будущего live-индикатора
│   │   └── bridge.ts               IPC-контракт
│   └── renderer/
│       ├── main.tsx               Начальное Electron-окно и проверка видео
│       └── styles.css             Tailwind 4, тёмная тема
├── templates/
│   ├── gaming-reference.json       Исходный JSON из задания
│   └── clean-vertical.json         Готовый шаблон без внешних assets
├── tests/
│   ├── engine.test.ts              Формула, схема, граф, аргументы, прогресс
│   ├── helpers.ts
│   └── integration/
│       ├── render.test.ts          Реальные файлы, слои, trim, звук, two-pass
│       └── encoders.test.ts        Реальная матрица кодеков и rate control
├── scripts/
│   ├── render.ts                   CLI рендера / генерации плана
│   ├── demo.ts                     Воспроизводимый синтетический пример
│   └── run.ps1                     Запуск с локальными FFmpeg/FFprobe
├── docs/architecture.md            Полная архитектура шагов 1–3 и границы модулей
├── electron.vite.config.ts
├── tsconfig.json
├── index.html
├── package.json
├── pnpm-lock.yaml
└── pnpm-workspace.yaml
```

Шаг 2 добавляет `src/main/services/{auth,tiktok,google-drive}`, `publishing-hub.ts`, `render-and-archive.ts`, `src/shared/publishing.ts`, панель `src/renderer/features/publishing/ConnectionsPanel.tsx`, сервисные тесты и `tests/electron`. Подробности — в [описании интеграций](docs/publishing.md).

## API движка

```typescript
import { renderVideo } from './src/main/engine/renderer';
import { templateSchema } from './src/shared/template';

const controller = new AbortController();
const plan = await renderVideo({
  template: templateSchema.parse(templateJson),
  templateDir: 'D:/templates',
  inputPath: 'D:/clips/source.mp4',
  outputPath: 'D:/renders/vertical.mp4',
  trim: { inSec: 2.1, outSec: 12.1 },
}, {
  signal: controller.signal,
  allowSoftwareFallback: true,
  onProgress: ({ fraction, speed }) => console.log(fraction, speed),
});
```

`buildRenderPlan()` — чистая генерация, дополнительно принимает `media` с результатом `probeMedia()`. `renderVideo()` сам вызывает FFprobe, проверяет аппаратный кодек реальным однокадровым кодированием, при необходимости выбирает fallback той же кодек-семьи и выполняет план. Ошибки композитинга не скрываются повторной попыткой другим кодеком.

Выход сначала рендерится в собственную временную папку; успешный результат копируется с `COPYFILE_EXCL`. При отмене и ошибке временные файлы удаляются. Перезапись исходника и существующего результата запрещена. Отсутствующий аудиопоток не заменяется искусственным звуком.

## Семантика шаблона

- Имена из задания сохранены, включая `main_clip_layout.Position` с заглавной буквы.
- Координаты — пиксели фактического `canvas`, не нормализованные значения. Для 1440×2560 измените и холст, и координаты слоёв; произвольные чётные размеры также допустимы. Для высокого разрешения/FPS используйте `level: "auto"` либо подходящий уровень кодека.
- `Position` — прямоугольник основного видео. `fit_width` масштабирует по ширине и центрирует по вертикали в этом прямоугольнике; `contain` вписывает; `cover` заполняет с обрезкой. При выходе за границы холста FFmpeg обрезает изображение.
- `blur_pad` делает увеличенную размытую и затемнённую копию на фоне. `center_crop` заполняет основной прямоугольник центральным кропом; остальная область имеет `canvas.background_color`.
- Для `custom_crop` добавьте `main_clip_layout.source_crop: { x, y, width, height }` в пикселях исходника после учёта поворота. Кроп проверяется на попадание в исходный кадр.
- Визуальные слои сортируются по возрастающему `z_index`; при равенстве сохраняется порядок JSON. Аудио берётся только из основного видео.
- Для медиа размеры умножаются на необязательный `scale` (по умолчанию 1). Медиа масштабируются ровно в указанный прямоугольник. Прозрачность исходника сохраняется, `opacity` умножает её. PNG, GIF, WebP, зацикленные видео, alpha и `chroma_key` поддерживаются.
- Текст берётся из UTF-8 файла с `expansion=none`: кавычки, `%`, двоеточия и кириллица не становятся синтаксисом фильтра. Шрифт копируется в рабочую папку с безопасным именем; `font_file` обязателен. Размер шрифта и обводка масштабируются через `scale`.
- Тайминг считается от начала обрезанного ролика. `full_duration: true` задаёт весь ролик, игнорируя offsets. Иначе `end_offset_sec: null` означает конец ролика. Интервал `[start, end)`. Выход за длину и пересекающиеся fade-in/fade-out отклоняются с ошибкой.
- В эталонном JSON есть ссылки на не предоставленные `templates/assets/overlays/logo_banner.png` и `templates/assets/fonts/Montserrat-Bold.ttf`. Эти assets нужно добавить самостоятельно или изменить пути. Для запуска без них используйте `clean-vertical.json`.

Динамические подписи пока формируются вызывающим кодом через `text_content`; автоматическая расшифровка речи и текст, меняющийся внутри одного слоя, не входят в этот шаг. Для смены подписи используются несколько текстовых слоёв с разными интервалами.

## Кодирование и оценка веса

Поддерживаются `h264_nvenc`, `hevc_nvenc`, `libx264`, `libx265`; `cbr`, `vbr`, `vbr_2pass`, `cqp`, `crf`. NVENC принимает `p1`–`p7`; программные кодеки используют отдельный `software_preset`. Для 8-bit HEVC схема требует `profile: "main"` и fallback `libx265`; H.264 использует fallback `libx264`. `quality` — значение CRF/CQP/CQ (по умолчанию 23).

NVENC `vbr_2pass` означает внутренний `-multipass fullres`, а не два чтения всего файла. x264 использует `-pass 1/2`, x265 — `pass=1/2:stats=...`. При выборе CRF с NVENC используется VBR CQ с `-b:v 0`, о чём план сообщает предупреждением. Это другой алгоритм, чем CRF x264/x265.

Калькулятор для CBR/VBR:

```text
MB = ((target_video_kbps + audio_kbps) × (outSec − inSec)) / 8192
```

Для 60 сек, 18 000 kbps видео и 256 kbps аудио: **133.7109375 MB**. По заданной формуле это бинарные MiB; MP4 overhead не включён. VBR и AAC могут отклоняться от цели. Если звука нет, audio_kbps = 0. Для CRF/CQP возвращается `megabytes: null`, чтобы UI не показывал ложную точность.

AAC: 192–320 kbps / 48 kHz. Нормализация — однопроходный `loudnorm=I=-14:TP=-1:LRA=11`, не измерительный двухпроходный мастеринг. Выход — MP4 с `+faststart`, CFR, квадратным пикселем и `yuv420p`. Фильтры исполняются на CPU; NVENC ускоряет кодирование, а не весь граф.

Прогресс получает `out_time_us`/`speed` из `-progress pipe:1` и `time=`/`speed=` из stderr, учитывает номер прохода. До успешного сохранения максимум — 99.9%; 100% выдаётся после завершения записи.

## Проверки

```powershell
.\scripts\run.ps1 test
.\scripts\run.ps1 build
$env:TEST_NVENC = '1'
.\scripts\run.ps1 test:integration
```

Без `TEST_NVENC=1` аппаратные интеграционные тесты пропускаются; программные выполняются всегда. Тесты создают собственные короткие ролики и очищают только свои временные папки. Для Linux задайте `TEST_FONT_PATH`, если DejaVu Sans отсутствует.

Опорные источники: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [NVIDIA FFmpeg/NVENC](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html), [Electron preload и IPC](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload).
