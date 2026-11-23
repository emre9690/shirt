import { useCallback, useEffect, useState } from 'react';
import { deserializeMesh, type ShirtSize, type SimPackage } from '@shirt/garment-schema';
import type { PreparedGarment } from './runtime';

const API = import.meta.env.VITE_PREPROCESS_URL ?? 'http://127.0.0.1:8765';

interface GarmentCard { id: string; name: string; size: ShirtSize; method: string }
interface ImportRecord { id: string; url: string | null; status: string; error: string | null; product: { name?: string; article?: string } }
interface Job { id: string; garmentId: string; stage: string; status: string; error: string | null; blocked: boolean }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${response.status})`);
  }
  return response.json();
}

export function GarmentLibrary({ size, selected, onSelect }: { size: ShirtSize; selected: string | null; onSelect: (g: PreparedGarment | null, id: string | null, label: string) => void }) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [garments, setGarments] = useState<GarmentCard[]>([]);
  const [url, setUrl] = useState('');
  const [record, setRecord] = useState<ImportRecord | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setGarments(await api<GarmentCard[]>('/garments'));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') {
      if (job?.status === 'done') void refresh();
      return;
    }
    const timer = setTimeout(async () => {
      try { setJob(await api<Job>(`/jobs/${job.id}`)); } catch (e) { setError((e as Error).message); }
    }, 500);
    return () => clearTimeout(timer);
  }, [job, refresh]);

  const run = async (action: () => Promise<void>) => {
    setError('');
    try { await action(); } catch (e) { setError((e as Error).message); }
  };

  const importUrl = () => run(async () => {
    setRecord(await api<ImportRecord>('/imports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }));
  });

  const upload = (files: FileList | null) => run(async () => {
    if (!files?.length) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append('files', f));
    if (record?.product.name) form.append('name', record.product.name);
    if (record?.product.article) form.append('article', record.product.article);
    if (url) form.append('url', url);
    setRecord(await api<ImportRecord>('/imports/upload', { method: 'POST', body: form }));
  });

  const prepare = () => run(async () => {
    setJob(await api<Job>('/garments/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ importId: record!.id, size, method: 'procedural-template' }) }));
  });

  const load = (card: GarmentCard) => run(async () => {
    const sim = await api<SimPackage>(`/garments/${card.id}/files/sim.json`);
    const { mesh, params } = deserializeMesh(sim);
    onSelect({ size: card.size, params, mesh }, card.id, `${card.name} (${card.size}), ${card.method}`);
  });

  if (online === false) {
    return <small>Garment import is offline. Start the preprocess service to add products. The built-in shirt still works.</small>;
  }

  return (
    <section className="card">
      <strong>Add a product</strong>
      <div className="row">
        <input aria-label="Product URL" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button onClick={importUrl} disabled={!url}>Import</button>
      </div>
      <label>Upload images <input aria-label="Upload images" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => upload(e.target.files)} /></label>
      {record?.error && <small className="warn">{record.error}</small>}
      {record && <button onClick={prepare}>Prepare template shirt, size {size}</button>}
      {job && <small role="status">Job: {job.status}, stage {job.stage}{job.error ? `. ${job.error}` : ''}</small>}
      {error && <small className="warn">{error}</small>}
      {garments.length > 0 && <strong>Prepared</strong>}
      {garments.map((g) => (
        <button key={g.id} className={selected === g.id ? 'garment active' : 'garment'} onClick={() => load(g)}>{g.name} · {g.size} · {g.method}</button>
      ))}
      {selected && <button onClick={() => onSelect(null, null, '')}>Use built-in shirt</button>}
    </section>
  );
}
