import { useCallback, useEffect, useState } from 'react';
import { CloudUpload, Link2, Upload } from 'lucide-react';
import type { CreatorInfo, DriveFolder, PostInfo, PublishingState, SelectedUploadFile, ServiceEvent } from '../../../shared/publishing';
import { useEditorStore } from '../../stores/editor-store';

const button = 'ui-button ui-button-outline';
const field = 'connection-field';
const api = () => window.desktop.publishing;
export function ConnectionsPanel({ renderedFile }: { renderedFile?: SelectedUploadFile }) {
  const [accounts, setAccounts] = useState<PublishingState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState({ tiktok: false, google: false });
  const [callbackUrl, setCallbackUrl] = useState('');
  const [creator, setCreator] = useState<CreatorInfo>();
  const [file, setFile] = useState<SelectedUploadFile | null>(null);
  const [mode, setMode] = useState<'direct_post' | 'inbox'>('inbox');
  const [consent, setConsent] = useState(false);
  const [post, setPost] = useState<PostInfo>({ title: '', privacy_level: '', disable_comment: true,
    disable_duet: true, disable_stitch: true, video_cover_timestamp_ms: 0 });
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [nextPage, setNextPage] = useState<string>();
  const folderId = useEditorStore(s => s.driveFolderId);
  const setFolderId = (id: string) => useEditorStore.setState({ driveFolderId: id });
  const [folderName, setFolderName] = useState('AutoClipping_Renders');
  const [events, setEvents] = useState<Record<string, ServiceEvent>>({});
  const [publishId, setPublishId] = useState('');
  const [postStatus, setPostStatus] = useState('');
  useEffect(() => { if (renderedFile) { setFile(renderedFile); setConsent(false); } }, [renderedFile?.id]);
  const refresh = useCallback(async () => { setAccounts(await api().state()); }, []);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    void refresh().catch(error => setError(String(error)));
    return api().onEvent(event => {
      if (event.kind === 'auth') {
        setAuth(previous => ({ ...previous, [event.provider]: false }));
        if (event.message) setError(event.message);
        void refresh().catch(error => setError(String(error)));
      } else {
        setEvents(previous => {
          const old = previous[event.id];
          return { ...previous, [event.id]: { ...old, ...event, result: { ...old?.result, ...event.result }, progress: event.progress ?? old?.progress } };
        });
        if (event.result?.publishId) setPublishId(event.result.publishId);
      }
    });
  }, [refresh]);
  const loadFolders = async (token?: string) => {
    const page = await api().driveFolders(token);
    setFolders(previous => token ? [...previous, ...page.files] : page.files); setNextPage(page.nextPageToken);
  };
  const hasRunning = (provider: 'tiktok' | 'google') => Object.values(events).some(e => e.provider === provider && ['running', 'progress'].includes(e.phase));
  return <section className="connections-panel">
    <div className="flex items-center gap-3"><CloudUpload className="text-indigo-400" size={24} /><div>
      <h2 className="font-medium">Подключения</h2><p className="mt-1 text-xs text-zinc-500">Отправка готового MP4</p>
    </div></div>
    <div className="mt-4 text-xs text-zinc-500"><p>OAuth-настройки: <span className="break-all">{accounts?.configurationPath ?? 'Загрузка…'}</span></p>
      <button className={`${button} mt-2`} onClick={() => void perform(() => api().openConfigFolder())}>Открыть папку настроек</button></div>
    {error && <p role="alert" className="mt-4 whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
    <div className="mt-6 flex flex-wrap items-center gap-3"><button className={button} disabled={busy} onClick={() => void perform(async () => {
      const selected = await api().selectUploadFile(); if (selected) { setFile(selected); setConsent(false); }
    })}><Upload size={15} className="mr-2 inline" />Выбрать MP4</button>
      <span className="text-sm text-zinc-400">{file ? `${file.name} · ${(file.size / 1024 ** 2).toFixed(1)} MB · ${file.durationSec.toFixed(1)} сек` : 'Файл не выбран'}</span>
    </div>
    <div className="connections-columns">
      <div className="connection-card space-y-4">
        <h3 className="font-medium">TikTok <span className="ml-2 text-xs text-zinc-500">{accounts?.tiktok.connected ? 'Подключён' : 'Не подключён'}</span></h3>
        {!accounts?.tiktok.configured && <p className="text-sm text-amber-300">Укажите TIKTOK_CLIENT_KEY и TIKTOK_CLIENT_SECRET в файле настроек, затем перезапустите приложение.</p>}
        <div className="flex flex-wrap gap-2">
          {(['window', 'external'] as const).map(method => <button key={method} className={button} disabled={busy || !accounts?.tiktok.configured}
            onClick={() => void perform(async () => { setAuth(a => ({ ...a, tiktok: true })); try { await api().connectTikTok(method); } catch (e) { setAuth(a => ({ ...a, tiktok: false })); throw e; } })}>
            {method === 'window' ? 'Войти в окне TikTok' : 'Войти в браузере'}</button>)}
          {auth.tiktok && <button className={button} onClick={() => void perform(() => api().cancelAuth('tiktok'))}>Отменить вход</button>}
          {accounts?.tiktok.connected && <button className={button} disabled={busy} onClick={() => void perform(async () => {
            await api().disconnect('tiktok'); setCreator(undefined); setPost(p => ({ ...p, privacy_level: '' })); await refresh();
          })}>Отключить</button>}
        </div>
        <label className="block text-xs text-zinc-400">Резервный callback URL из браузера<input aria-label="TikTok callback URL" className={`${field} mt-2`} value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)} placeholder="https://arter2k.github.io/AutoClippingUpgrader/callback?code=…&state=…" /></label>
        <button className={button} disabled={busy || !auth.tiktok || !callbackUrl} onClick={() => void perform(async () => { await api().completeTikTok(callbackUrl); setCallbackUrl(''); await refresh(); })}>Применить URL</button>
        <label className="block text-xs text-zinc-400">Режим<select className={`${field} mt-2`} value={mode} onChange={e => { setMode(e.target.value as typeof mode); setConsent(false); }}>
          <option value="inbox">Upload to Inbox — черновик</option><option value="direct_post">Direct Post — публикация</option>
        </select></label>
        {mode === 'inbox' ? <p className="text-sm text-zinc-400">После загрузки откройте уведомление TikTok на телефоне, добавьте звук и завершите публикацию.</p> : <>
          <button className={button} disabled={busy || !accounts?.tiktok.connected} onClick={() => void perform(async () => {
            const value = await api().creatorInfo(); setCreator(value); setPost(p => ({ ...p, privacy_level: '', disable_comment: true, disable_duet: true, disable_stitch: true }));
          })}>Получить Creator Info</button>
          {creator && <p className="text-sm text-zinc-300">{creator.creator_nickname} (@{creator.creator_username}) · до {creator.max_video_post_duration_sec} сек</p>}
          <label className="block text-xs text-zinc-400">Подпись<textarea className={`${field} mt-2`} maxLength={2200} value={post.title} onChange={e => setPost(p => ({ ...p, title: e.target.value }))} /></label>
          <label className="block text-xs text-zinc-400">Видимость<select className={`${field} mt-2`} value={post.privacy_level} onChange={e => setPost(p => ({ ...p, privacy_level: e.target.value }))}>
            <option value="">Выберите видимость</option>{creator?.privacy_level_options.map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          {(['comment', 'duet', 'stitch'] as const).map(name => <label key={name} className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={!post[`disable_${name}`]} disabled={!creator || creator[`${name}_disabled`]}
              onChange={e => setPost(p => ({ ...p, [`disable_${name}`]: !e.target.checked }))} />Разрешить {name}
          </label>)}
          <label className="block text-xs text-zinc-400">Кадр обложки, мс<input type="number" min={0} step={100} className={`${field} mt-2`} value={post.video_cover_timestamp_ms}
            onChange={e => setPost(p => ({ ...p, video_cover_timestamp_ms: Number(e.target.value) }))} /></label>
        </>}
        <label className="flex items-start gap-2 text-sm text-zinc-400"><input className="mt-1" type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          {mode === 'inbox' ? 'Отправить выбранный файл в мои черновики TikTok' : 'Опубликовать выбранный файл с указанными настройками'}</label>
        <button className={`${button} bg-indigo-600`} disabled={busy || !file || !accounts?.tiktok.connected || !consent || hasRunning('tiktok') || (mode === 'direct_post' && (!creator || !post.privacy_level))}
          onClick={() => void perform(async () => {
            if (!file) return;
            await api().startTikTok(mode === 'inbox' ? { mode, fileId: file.id, consent: true } : { mode, fileId: file.id, consent: true, postInfo: post }); setConsent(false);
          })}>Отправить в TikTok</button>
        <label className="block text-xs text-zinc-400">Publish ID<input className={`${field} mt-2`} value={publishId} onChange={e => setPublishId(e.target.value)} /></label>
        <button className={button} disabled={busy || !publishId || !accounts?.tiktok.connected} onClick={() => void perform(async () => {
          const result = await api().statusTikTok(publishId); setPostStatus(`${result.status}${result.fail_reason ? `: ${result.fail_reason}` : ''}`);
        })}>Проверить статус</button>{postStatus && <p className="text-xs text-zinc-400">{postStatus}</p>}
      </div>
      <div className="connection-card space-y-4">
        <h3 className="font-medium">Google Drive <span className="ml-2 text-xs text-zinc-500">{accounts?.google.connected ? 'Подключён' : 'Не подключён'}</span></h3>
        {!accounts?.google.configured && <p className="text-sm text-amber-300">Укажите GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET для Desktop OAuth-клиента в файле настроек, затем перезапустите приложение.</p>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !accounts?.google.configured || auth.google}
          onClick={() => void perform(async () => { setAuth(a => ({ ...a, google: true })); try { await api().connectGoogle(); } catch (e) { setAuth(a => ({ ...a, google: false })); throw e; } })}>
          <Link2 size={15} className="mr-2 inline" />Войти через Google</button>
          {auth.google && <button className={button} onClick={() => void perform(() => api().cancelAuth('google'))}>Отменить вход</button>}
          {accounts?.google.connected && <button className={button} disabled={busy} onClick={() => void perform(async () => {
            await api().disconnect('google'); setFolders([]); setFolderId(''); await refresh();
          })}>Отключить</button>}
        </div>
        <p className="text-sm text-zinc-400">Сессия незавершённой загрузки сохраняется. Повторная отправка того же файла в ту же папку продолжит её.</p>
        <button className={button} disabled={busy || !accounts?.google.connected} onClick={() => void perform(() => loadFolders())}>Загрузить список папок</button>
        <label className="block text-xs text-zinc-400">Папка назначения<select className={`${field} mt-2`} value={folderId} onChange={e => setFolderId(e.target.value)}>
          <option value="">Выберите папку</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select></label>
        {nextPage && <button className={button} disabled={busy} onClick={() => void perform(() => loadFolders(nextPage))}>Следующие папки</button>}
        <label className="block text-xs text-zinc-400">Новая папка<input className={`${field} mt-2`} value={folderName} onChange={e => setFolderName(e.target.value)} /></label>
        <button className={button} disabled={busy || !accounts?.google.connected || !folderName.trim()} onClick={() => void perform(async () => {
          const folder = await api().createDriveFolder(folderName); setFolders(previous => [...previous, folder]); setFolderId(folder.id);
        })}>Создать папку</button>
        <p className="text-xs text-zinc-500">При разрешении drive.file доступны папки, созданные или разрешённые этому приложению. Настройка полного Drive scope описана в docs/publishing.md.</p>
        <button className={`${button} block bg-indigo-600`} disabled={busy || !file || !accounts?.google.connected || !folderId || hasRunning('google')}
          onClick={() => void perform(async () => { if (file) await api().startDrive(file.id, folderId); })}>Загрузить / продолжить</button>
      </div>
    </div>
    {Object.values(events).map(event => <div key={event.id} className="mt-4 rounded-lg border border-white/10 p-3 text-sm text-zinc-400">
      <p>{event.provider === 'tiktok' ? 'TikTok' : 'Google Drive'} · {event.phase} {event.result?.status && `· ${event.result.status}`}</p>
      {event.progress && <><progress aria-label="Прогресс загрузки" className="mt-2 w-full accent-indigo-500" max={1} value={event.progress.fraction} /><p className="text-xs">{(event.progress.fraction * 100).toFixed(1)}% байтов подтверждено сервером</p></>}
      {event.result?.publishId && <p className="mt-1 break-all text-xs">Publish ID: {event.result.publishId}</p>}
      {event.result?.fileId && <p className="mt-1 break-all text-xs">Drive file ID: {event.result.fileId}</p>}
      {event.message && <p role="alert" className="mt-2 text-red-300">{event.message}</p>}
      {['running', 'progress'].includes(event.phase) && <button className={`${button} mt-2`} onClick={() => void perform(() => api().cancelJob(event.id))}>Отменить ожидание / загрузку</button>}
    </div>)}
  </section>;
}
