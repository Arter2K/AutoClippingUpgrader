# Шаг 2: TikTok и Google Drive

Сервисы реализованы и подключены к Electron через ограниченный preload API. Во вкладке публикации полноценного редактора доступны OAuth, ручной callback TikTok, выбор готового MP4, Creator Info, direct/inbox, папки Drive, прогресс, отмена и повторный запрос статуса. В инспекторе экспорта есть переключатель загрузки в Drive после рендера. Готовый локальный результат автоматически подставляется в панель публикации. Руководство интерфейса — в [editor.md](editor.md).

## Настройка

В корне проекта создайте `.env` по образцу [.env.example](../.env.example) и заполните реквизиты своих приложений. Файл игнорируется Git. Заполненные значения не следует отправлять в чат или добавлять в исходники.

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
# Заполните .env в текстовом редакторе
.\scripts\run.ps1 dev
```

Этот пример предполагает, что `.env` ещё нет. После изменения параметров нужен перезапуск main-процесса Electron. В EXE-версии конфигурация читается из `oauth.env` в `app.getPath('userData')`. Путь показан в панели публикации; кнопка «Открыть папку настроек» создаёт образец только при отсутствии файла. Значения process environment имеют приоритет. `VITE_` для секретов не используется.

### TikTok

- `TIKTOK_CLIENT_KEY` и `TIKTOK_CLIENT_SECRET`: реквизиты приложения TikTok for Developers с Login Kit и Content Posting API.
- Запрашиваемые scopes: `user.info.basic`, `video.publish`, `video.upload`. Пользователь может предоставить не все; перед соответствующей операцией проверяется фактический grant.
- Точный callback из задания сохранён: `https://arter2k.github.io/AutoClippingUpgrader/callback`. Origin и pathname сравниваются строго, состояние `state` обязательно, дубликаты критических query-параметров отклоняются.
- В актуальной документации Login Kit Desktop перечислены loopback redirect URI. Заданный HTTPS callback должен быть разрешён именно в конфигурации вашего клиента/платформы в портале. Его наличие и совместимость нельзя проверить без приложения разработчика. Реализация не подменяет этот callback локальным адресом и не обходит ограничения провайдера.
- Для TikTok Desktop используется SHA-256 **hex** challenge, согласно документации TikTok. `code_verifier` отправляется на token endpoint; `code` декодируется ровно один раз через URLSearchParams.

Вход по кнопке «Войти в окне TikTok» открывает дочерний sandboxed BrowserWindow без preload и Node. `will-redirect` и `will-navigate` перехватывают callback до загрузки GitHub Pages. После получения кода окно закрывается, обмен и сохранение токенов выполняются в main. Временная browser-session не сохраняет cookies на диск.

Для резервного пути нажмите «Войти в браузере». Он создаёт новую пару `state`/PKCE и открывает системный браузер. После согласия скопируйте полный redirect URL с `code` **и** `state` в поле приложения. URL из старой сессии не подходит. Если логин внутри Electron блокируется провайдером, используйте этот путь; ограничения веб-сайта не отключаются.

Сессия живёт 10 минут. Закрытие auth-окна или кнопка отмены завершают попытку. Валидный код потребляется один раз. Токены из ответа не возвращаются в renderer.

### Google Drive

- В Google Cloud включите Drive API v3, настройте consent screen/test users и создайте OAuth client типа **Desktop app**.
- Заполните `GOOGLE_CLIENT_ID`; если выдан Desktop client secret, укажите `GOOGLE_CLIENT_SECRET`. Нативное приложение не может гарантировать конфиденциальность встроенного client secret; для массового распространения TikTok-конфигурации с секретом потребуется собственный backend обмена токенами.
- По умолчанию `GOOGLE_DRIVE_SCOPE=https://www.googleapis.com/auth/drive.file`. При этом список показывает только папки/файлы, доступные этому приложению. Кнопка «Создать папку» позволяет создать и выбрать `AutoClipping_Renders` без полного доступа ко всему диску.
- Для просмотра и выбора произвольных существующих папок можно явно настроить `GOOGLE_DRIVE_SCOPE=https://www.googleapis.com/auth/drive`. Такой scope шире и может требовать дополнительной проверки приложения Google. После изменения scope переподключите аккаунт.

Google OAuth открывает **системный браузер**, а не embedded WebView. Receiver слушает только `127.0.0.1` на случайном порту. PKCE challenge — SHA-256 base64url. Проверяются host, путь, state, одноразовость и timeout; HTML не содержит токенов/кодов, ответы не кешируются. Используется offline access для refresh token. Receiver закрывается при успехе, отмене или timeout.

## Работа в интерфейсе

1. Выберите готовый MP4 через системный диалог. Renderer получает непрозрачный UUID, имя, размер и длительность; загрузчик принимает только ранее выбранный файл. Изменённый после выбора файл нужно выбрать заново.
2. Подключите нужный аккаунт.
3. Для TikTok выберите режим:
   - **Inbox**: отправка без `post_info`, после статуса `SEND_TO_USER_INBOX` нужно открыть уведомление TikTok на телефоне и завершить редактирование/публикацию.
   - **Direct Post**: получите Creator Info, выберите доступную видимость, подпись, взаимодействия и кадр обложки. Видимость не выбирается автоматически. Backend повторно получает Creator Info перед init и проверяет длительность, видимость и interaction flags.
4. Для TikTok отметьте соответствующее действие и нажмите отправку. Для Drive получите список/создайте папку, выберите её и нажмите «Загрузить / продолжить».
5. Панель показывает подтверждённые сервером байты отдельно от статуса обработки. Для TikTok сохраните Publish ID, если хотите проверить обработку позднее; поле принимает его вручную.

Никакой реальный пост не создаётся только от запуска приложения, подключения аккаунта или тестов. Кнопка отключения отзывает доступ у провайдера и удаляет локальный токен после успешного revoke. Отмена загрузки/ожидания не удаляет уже принятое или опубликованное видео: отменяется локальная операция, а её состояние можно проверить по Publish ID.

## Протокол загрузок

TikTok использует только официальные v2 endpoints:

```text
https://www.tiktok.com/v2/auth/authorize/
https://open.tiktokapis.com/v2/oauth/token/
https://open.tiktokapis.com/v2/oauth/revoke/
https://open.tiktokapis.com/v2/post/publish/creator_info/query/
https://open.tiktokapis.com/v2/post/publish/video/init/
https://open.tiktokapis.com/v2/post/publish/inbox/video/init/
https://open.tiktokapis.com/v2/post/publish/status/fetch/
```

FILE_UPLOAD передаётся последовательными PUT-запросами к выданному `upload_url`. Размеры вычисляются через `floor(video_size / chunk_size)`; остаток присоединяется к последнему чанку. Маленький файл передаётся целиком. Устанавливаются Content-Length, Content-Type и точный Content-Range. Ожидаются 206 для промежуточного чанка и 201 для последнего. Signed URL не попадает в UI, а bearer token не отправляется на upload host.

После потери ответа загрузчик проверяет `uploaded_bytes` через status API. Если весь чанк подтверждён, передача продолжается; если сервер подтвердил прежнее смещение — возможен ограниченный повтор. При неопределённом/частичном смещении операция завершается с `upload_uncertain`, сохранив Publish ID в текущей панели. Init не повторяется после неоднозначной сетевой ошибки, чтобы не создать второй пост. Поллинг ограничен по времени и поддерживает отмену; при долгой модерации можно запросить статус позднее.

Drive использует `POST /upload/drive/v3/files?uploadType=resumable` и последовательные PUT. Длина чанков кратна 256 KiB, кроме последнего; по умолчанию 8 MiB. После HTTP 308 читается фактический Range; после сетевого сбоя, 429 или 5xx выполняется запрос смещения `Content-Range: bytes */TOTAL`. Повтор не предполагает, что все отправленные байты были приняты. Сетевые повторы ограничены и прерываются AbortSignal. Для 401 загрузчик обновляет access token. Истёкшая сессия не используется повторно.

Сессия Drive хранится зашифрованно и связывается с client ID, аккаунтом (`about.user.permissionId`), полным путём файла, папкой, размером и mtime. Незавершённую загрузку можно продолжить после перезапуска, повторно выбрав тот же неизменённый файл и папку. Если файл изменён, нужна новая сессия. Перед загрузкой проверяется право добавлять файлы в выбранную папку. Общие/Shared Drives отдельно не реализованы.

## Хранение и IPC

`oauth-tokens.bin` и `drive-resume/*.bin` находятся в Electron userData. Они шифруются через `safeStorage`; на Windows используется системная защита. При недоступном OS encryption или Linux backend `basic_text` приложение отказывается сохранять данные в plaintext. Записи сериализуются и заменяются через временный файл. Refresh token rotation TikTok и сохранение старого refresh token при отсутствии нового у Google обработаны.

Preload раскрывает только `window.desktop.publishing` с перечисленными методами. Main проверяет webContents и главный frame отправителя, валидирует аргументы через Zod, не принимает произвольный путь для загрузки и не отдаёт OAuth-токены renderer. Upload URL проверяется по HTTPS и домену провайдера, HTTP-редиректы автоматически не прослеживаются. Непроверенный текст сетевых исключений скрывается, чтобы signed URL не оказался в панели ошибки.

## Backend API

```typescript
// В main, после создания OAuth-клиентов и зашифрованных stores:
const result = await tiktokPublishing.upload({
  filePath: absoluteMp4Path,
  mode: 'inbox',
  consent: true,
}, { signal, onProgress, onInitialized: publishId => savePublishId(publishId) });

await tiktokPublishing.waitForStatus(result.publishId, 'inbox', { signal });
await driveUpload.upload(absoluteMp4Path, selectedFolderId, { signal, onProgress });
```

Для автозагрузки после рендера используйте `src/main/services/render-and-archive.ts`:

```typescript
await renderAndArchive(renderInput, {
  autoUpload: true,
  driveFolderId: selectedFolderId,
  signal,
  onProgress: onRenderProgress,
  onUploadProgress,
}, driveUpload);
```

Хук вызывает Drive только после успешного сохранения рендера. При ошибке Drive готовое локальное видео остаётся на диске; повторять нужно загрузку, а не рендер. Автоматический TikTok Direct Post через этот хук не выполняется.

## Проверено и ограничения проверки

```powershell
.\scripts\run.ps1 test
.\scripts\run.ps1 build
.\scripts\run.ps1 test:electron
```

30 Node-тестов проверяют шаг 1 и сервисы шага 2: PKCE, state, exact callback, одноразовый код, обмен, refresh rotation/single-flight, независимую отмену потребителей токена, 401, отсутствие scopes, chunk boundaries, потоковое чтение настоящих файлов, Direct Post/Inbox payloads, Creator Info, 503, rate limit, Range, отмену, продолжение Drive-сессии, запрет повторного init и auto-upload hook. Сетевые TikTok/Drive ответы в этих тестах контролируемые; реальный локальный HTTP receiver проверяется отдельно.

Два native Electron smoke-теста проверяют настоящий `safeStorage`, зашифрованные сессии, загрузку собранного renderer/preload, отсутствие токенов и Node API в renderer, отказ IPC от чужого webContents. Для них сначала нужна сборка. Ранее созданные FFmpeg-интеграционные тесты запускаются отдельно через `test:integration`.

Реальный вход и загрузка в облачные аккаунты **не выполнялись**: OAuth-реквизиты не предоставлены. Одобрение scopes, ограничения клиента, модерация, лимиты аккаунтов и доступность платформ проверяются после настройки ваших приложений. Успешные локальные тесты не заменяют эту проверку.

## Официальные источники

- [TikTok Desktop Login Kit / PKCE](https://developers.tiktok.com/docs/en/login-kit-desktop)
- [TikTok token exchange, refresh, revoke](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)
- [TikTok Media Transfer Guide](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide)
- [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [Upload to Inbox](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video)
- [Creator Info](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info), [Post Status](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)
- [Google OAuth for Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Drive resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
