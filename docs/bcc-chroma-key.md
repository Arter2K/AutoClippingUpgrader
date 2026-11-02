# BCC-style Chroma Key Studio

Модуль версии 0.6.0 обрабатывает фото- и видеослои. Это собственная реализация многоступенчатого кеинга в стиле BCC, без библиотек или лицензии Boris FX и без обещания побитового совпадения с их продуктом. AI matting статичных изображений остаётся отдельным инструментом.

## Инспектор и просмотр

Выберите слой и включите `Enable Chroma Key`. Новые настройки создаются в режиме `bcc_chromakey_studio`. Старые `chromakey` и `chroma_key` продолжают давать прежний результат; для их явного перевода есть кнопка «Перевести в BCC Studio».

Четыре раскрывающиеся секции содержат Primary Key (Similarity, Hue/Saturation/Luma Weight), Matte Cleanup (Black/White Clip, Choke, Softness, Gamma), Spill Suppression (enabled, strength, balance, restore luminance) и Light Wrap (enabled, intensity, width). Reset to Default восстанавливает весь BCC-конфиг, включая ключевой цвет и режим просмотра. Ползунки и пипетка участвуют в undo/redo.

`Final Composite` показывает результат на нижних слоях. `Alpha Matte (B&W)` выводит маску внутри прямоугольника слоя: чёрное — прозрачность, белое — объект, серое — частичная прозрачность. `Source Only` показывает исходник. Эти режимы диагностические: MP4 и контрольный FFmpeg-кадр всегда используют Final Composite, даже если в инспекторе оставлен Alpha Matte.

Обе кнопки пипетки включают выбор с холста: целевой слой временно показывается без кеинга. При клике усредняются 3×3 пикселя Canvas с учётом исходного alpha; у границы холста берётся доступная часть области. Escape отменяет выбор. Системная одноточечная EyeDropper API не используется.

## Схема

```json
{
  "background_removal": {
    "mode": "bcc_chromakey_studio",
    "enabled": true,
    "view_mode": "final_composite",
    "primary_key": {
      "key_color": "#00FF00", "similarity": 0.14,
      "hue_weight": 1.0, "saturation_weight": 0.8, "luma_weight": 0.3
    },
    "matte_cleanup": {
      "black_clip": 0.10, "white_clip": 0.90,
      "matte_choke_px": -1.5, "matte_softness_px": 1.5, "matte_gamma": 1.0
    },
    "spill_suppression": {
      "enabled": true, "strength": 0.85, "balance": 0.5, "restore_luminance": true
    },
    "light_wrap": { "enabled": true, "intensity": 0.15, "width_px": 6.0 }
  }
}
```

Тип `BackgroundRemovalConfig` экспортируется из `shared/template.ts`; `BccChromaConfig`, схема, defaults и общие расчёты — из `shared/bcc-chroma.ts`. Пропущенные секции получают defaults. White Clip должен превышать Black Clip минимум на 0.001. Веса ограничены 0–2, Similarity — 0.01–1, Choke — ±20 px, Softness — 0–20 px, Gamma — 0.2–3, Light Wrap Width — 1–30 px. JSON сохраняется в проектах/шаблонах, включая сегменты многодорожечного таймлайна.

## WebGL2

`BccChromaKeyShader.ts` использует отдельные GPU-проходы: исходная маска, морфология 3×3, два прохода Gaussian blur, уровни/gamma и восстановление исходного alpha, despill и Light Wrap. Целые пиксели Choke дают повторные erosion/dilation, дробная часть интерполирует соседние состояния; −1.5 означает полную эрозию на 1 px и половину следующего шага. Параметры в пикселях масштабируются вместе с отображением слоя.

`BccLayerRenderer` берёт текущий нижний Canvas-композит с обратным преобразованием координат слоя, включая поворот. Light Wrap размывает эту текстуру и маску, затем смешивает цвет только в области `clamp(4*alpha*(1-blurredAlpha)*intensity)`. Непрозрачность слоя и fades применяются после обработки. Оба Canvas-пути, включая многодорожечный, используют этот renderer. Контексты и текстуры освобождаются при удалении слоя/декодера; WebGL feedback между проходами исключён.

В воспроизведении нет CPU-обхода пикселей или readPixels для BCC. Рабочее разрешение подстраивается под экран и ограничено 2048 px по большей стороне. При недоступном/потерянном WebGL2 показывается уведомление и исходник; экспорт FFmpeg остаётся доступен. Восстановить renderer можно переоткрытием проекта. Это не скрытая CPU-подмена эффекта.

60 FPS — цель GPU-превью, а не гарантированный результат для любых размеров/числа слоёв. Тест шейдера реально выполнен через Electron WebGL2 с SwiftShader на 64×64; этот микротест не является подтверждением 60 FPS на 1080p/4K. Gaussian blur WebGL и рекурсивный FFmpeg gblur, округление, YUV-конвертация и адаптивное разрешение могут немного различаться на мягких границах. Для финальной проверки есть FFmpeg-кадр.

## FFmpeg

`engine/bcc-chroma.ts` строит собственные labels для каждого слоя/сегмента:

1. Split на цвет, источник маски и исходную прозрачность.
2. Primary key. При весах `(1,1,0)` используется `chromakey:blend=0.25` и `alphaextract` (нейтральный ключ использует RGB colorkey, чтобы отличать чёрное от белого). Для произвольных весов применяется RGB `geq` с той же 3D-метрикой YCbCr, что в WebGL: `distance(Cb*hue, Cr*saturation, Y*luma)`. Это необходимо, поскольку native chromakey не имеет этих трёх параметров. Ползунки не игнорируются и не сворачиваются в один фиктивный Similarity.
3. Erosion/dilation с `coordinates=255`; дробный шаг через split/blend. Затем gblur при ненулевой Softness, colorlevels по всем RGB-каналам маски и eq gamma на серой маске.
4. Очищенная маска умножается на исходный alpha. White Clip и dilation не делают прозрачные пиксели PNG непрозрачными и не превращают исходные 50% alpha в 100%.
5. Цвет обрабатывается despill с явными green/blue channel scales, mix=balance, expand=0, strength и luminance compensation. Blue key не оставляет стандартное удаление зелёного канала включённым.
6. Alphamerge собирает слой. Light Wrap работает после размещения/поворота в координатах холста: размывает настоящий нижний композит и маску, использует maskedmerge и возвращает исходный alpha. В timeline это текущий `stage`, а не цвет canvas или прозрачная подложка локального сегмента. Opacity/fades применяются после Light Wrap, чтобы они не превращали весь полупрозрачный объект в область подсветки.

Веса используют названия из ТЗ; математически Hue/Saturation Weight взвешивают оси Cb/Cr из предоставленной YCbCr-метрики, а не HSV hue/saturation.

Основание для native-опций: [официальная документация фильтров FFmpeg](https://ffmpeg.org/ffmpeg-filters.html), [реализация despill FFmpeg 9](https://www.ffmpeg.org/doxygen/9.0/vf__despill_8c_source.html).

## Проверки

- `tests/bcc.test.ts`: defaults, валидация, веса, уровни/gamma, despill, 3×3 average, дробная морфология, граф и undo пипетки.
- `tests/integration/bcc.test.ts`: реальные RGBA-выходы FFmpeg, исходный alpha, erosion/dilation ±1.5, softness/gamma, зелёный/синий despill, взвешенный и native key, Light Wrap от нижнего видео в обоих графах, opacity/fades.
- `tests/electron/bcc-smoke.cjs`: реальные GLSL compile/link/render/readback, все view modes, исходная прозрачность, Choke/Softness/Gamma, фон Light Wrap и отсутствие ошибок WebGL.
- `test:effects`: инспектор, ползунки, реальная B&W-маска в Canvas, Reset, пипетка 3×3, FFmpeg-кадр, затем прежнее offline AI matting и undo.

Артефакты: `out/bcc-qa/webgl-results.json`, `webgl-matte.png`, `ffmpeg-light-wrap.png`, `out/editor-qa/bcc-alpha-matte.png`.
