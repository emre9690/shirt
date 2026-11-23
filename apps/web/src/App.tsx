import { useCallback, useEffect, useRef, useState } from 'react';
import { HM_PUBLISHED_SIZES_CM, type ShirtSize } from '@shirt/garment-schema';
import { GarmentView } from './rendering/garmentView';
import { prepareTemplateGarment, StageTimer, TryOnSession } from './runtime';
import { OneEuroVector } from './tracking/oneEuro';
import { createPoseTracker, type PoseTracker } from './tracking/pose';
import {
  DEFAULT_PROFILE, JOINTS, fitImage, poseFromWorld, profileScale, scalePose, syntheticPose, trackingConfidence,
  type BodyPose, type BodyProfile, type ImageFit, type P3,
} from './tracking/body';

type Mode = 'idle' | 'loading' | 'calibrating' | 'live' | 'demo' | 'error';
type Tracking = 'none' | 'good' | 'weak' | 'lost';

interface Stats {
  renderFps: number; poseFps: number; poseP95: number; physicsP50: number; physicsP95: number; renderP95: number;
  strain: number; vertices: number; delegate: string; dropped: number; refits: number;
}

const SIZES = Object.keys(HM_PUBLISHED_SIZES_CM) as ShirtSize[];
const CALIBRATION_FRAMES = 30;
const LOST_AFTER_MS = 350;

function cameraError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError') return 'Camera permission was denied. Allow it in your browser settings and try again.';
  if (name === 'NotFoundError') return 'No camera was found.';
  if (name === 'NotReadableError') return 'The camera is in use by another app.';
  return `Could not start: ${(e as Error)?.message ?? e}`;
}

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<GarmentView | null>(null);
  const sessionRef = useRef<TryOnSession | null>(null);
  const trackerRef = useRef<PoseTracker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const modeRef = useRef<Mode>('idle');
  const optsRef = useRef({ wireframe: false, showColliders: false });
  const scaleRef = useRef<number | null>(null);
  const calibrationRef = useRef<number[]>([]);
  const profileRef = useRef<BodyProfile>(DEFAULT_PROFILE);

  const [mode, setModeState] = useState<Mode>('idle');
  const [size, setSize] = useState<ShirtSize>('M');
  const [heightCm, setHeightCm] = useState(175);
  const [tracking, setTracking] = useState<Tracking>('none');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [dev, setDev] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showColliders, setShowColliders] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m); };

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    trackerRef.current?.close();
    trackerRef.current = null;
    sessionRef.current = null;
    viewRef.current?.setOpacity(0);
    viewRef.current?.render();
    scaleRef.current = null;
    calibrationRef.current = [];
    setTracking('none');
    setStats(null);
    setMode('idle');
  }, []);

  useEffect(() => () => { stop(); viewRef.current?.dispose(); viewRef.current = null; }, [stop]);

  const ensureView = () => {
    if (!viewRef.current) viewRef.current = new GarmentView(canvasRef.current!);
    return viewRef.current;
  };

  const mountGarment = (s: ShirtSize) => {
    const prepared = prepareTemplateGarment(s);
    const view = ensureView();
    view.setGarment(prepared.mesh);
    view.setOptions(optsRef.current);
    sessionRef.current = new TryOnSession(prepared, profileRef.current);
    return sessionRef.current;
  };

  const runLoop = (getPose: (now: number) => { pose: BodyPose; fit: ImageFit } | null, delegate: string, width: number, height: number) => {
    const view = ensureView();
    view.resize(width, height);
    const physics = new StageTimer();
    const draw = new StageTimer();
    let last = performance.now();
    let lastGood = last;
    let opacity = 0;
    let frames = 0;
    let statClock = last;
    let dropped = 0;
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      const session = sessionRef.current;
      if (!session) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      if (now - last > 50) dropped++;
      last = now;
      const tracked = getPose(now);
      if (tracked) {
        lastGood = now;
        session.updatePose(tracked.pose);
        view.setFit(tracked.fit);
        view.updateBody(session.capsules, optsRef.current.showColliders);
      }
      const lost = now - lastGood > LOST_AFTER_MS;
      if (lost) session.markTrackingLost();
      else {
        const t0 = performance.now();
        session.step(dt);
        physics.add(performance.now() - t0);
      }
      const ready = modeRef.current === 'live' || modeRef.current === 'demo';
      opacity += ((ready && !lost ? 1 : 0) - opacity) * Math.min(1, dt * 10);
      view.setOpacity(opacity);
      view.updateCloth(session.solver.x);
      const t1 = performance.now();
      view.render();
      draw.add(performance.now() - t1);
      frames++;
      if (now - statClock >= 500) {
        const seconds = (now - statClock) / 1000;
        const p = poseCounter.take();
        setStats({
          renderFps: frames / seconds, poseFps: p.count / seconds, poseP95: p.timer.percentile(0.95),
          physicsP50: physics.percentile(0.5), physicsP95: physics.percentile(0.95), renderP95: draw.percentile(0.95),
          strain: session.solver.maxStrain(), vertices: session.solver.n, delegate, dropped, refits: session.refits,
        });
        frames = 0;
        statClock = now;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const poseCounter = useRef((() => {
    const timer = new StageTimer();
    let count = 0;
    return { timer, hit: (ms: number) => { count++; timer.add(ms); }, take: () => { const c = count; count = 0; return { count: c, timer }; } };
  })()).current;

  const startCamera = async () => {
    stop();
    setMessage('');
    setMode('loading');
    profileRef.current = { heightM: heightCm / 100 };
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support camera access.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const tracker = await createPoseTracker();
      trackerRef.current = tracker;
      mountGarment(size);
      setMode('calibrating');
      setMessage('Stand back so your head and hips are visible, arms slightly away from your body.');
      const filter = new OneEuroVector(JOINTS.length * 3);
      let lastVideoTime = -1;
      let lastStamp = 0;
      const getPose = (now: number) => {
        if (video.currentTime === lastVideoTime) return null;
        lastVideoTime = video.currentTime;
        const stamp = Math.max(lastStamp + 1, Math.round(now));
        lastStamp = stamp;
        const t0 = performance.now();
        const result = tracker.detect(video, stamp);
        poseCounter.hit(performance.now() - t0);
        if (!result) { setTracking('lost'); filter.reset(); return null; }
        const confidence = trackingConfidence(result.image);
        if (confidence < 0.5) { setTracking('lost'); filter.reset(); return null; }
        setTracking(confidence > 0.8 ? 'good' : 'weak');
        const raw = poseFromWorld(result.world);
        if (scaleRef.current === null) {
          calibrationRef.current.push(profileScale(raw, profileRef.current));
          setProgress(calibrationRef.current.length / CALIBRATION_FRAMES);
          if (calibrationRef.current.length >= CALIBRATION_FRAMES) {
            const sorted = [...calibrationRef.current].sort((a, b) => a - b);
            scaleRef.current = sorted[Math.floor(sorted.length / 2)];
            setMode('live');
            setMessage('');
          }
        }
        const scaled = scalePose(raw, scaleRef.current ?? profileScale(raw, profileRef.current));
        const flat = JOINTS.flatMap((j) => scaled[j]);
        const smooth = filter.filter(flat, now / 1000);
        const pose = {} as BodyPose;
        JOINTS.forEach((j, i) => { pose[j] = [smooth[i * 3], smooth[i * 3 + 1], smooth[i * 3 + 2]] as P3; });
        const fit = fitImage(pose, result.image, video.videoWidth, video.videoHeight);
        return fit ? { pose, fit } : null;
      };
      runLoop(getPose, tracker.delegate, video.videoWidth, video.videoHeight);
    } catch (e) {
      stop();
      setMode('error');
      setMessage(cameraError(e));
    }
  };

  const startDemo = () => {
    stop();
    setMessage('Synthetic motion. This does not use your camera.');
    profileRef.current = { heightM: heightCm / 100 };
    mountGarment(size);
    setMode('demo');
    const start = performance.now();
    const [w, h] = [960, 720];
    const fit: ImageFit = { scale: 620, tx: w / 2, ty: h * 0.2 };
    runLoop((now) => ({ pose: syntheticPose((now - start) / 1000), fit }), 'synthetic', w, h);
  };

  const changeSize = (s: ShirtSize) => {
    setSize(s);
    if (sessionRef.current) mountGarment(s);
  };

  const running = mode === 'live' || mode === 'demo' || mode === 'calibrating';

  return (
    <div className="app">
      <main className="stage-wrap">
        <div className="stage">
          <video ref={videoRef} playsInline muted />
          <canvas ref={canvasRef} data-testid="garment-canvas" />
          {mode === 'idle' && <div className="placeholder">Select a size, then start your camera.</div>}
          {mode === 'loading' && <div className="placeholder">Starting camera and pose tracking…</div>}
          {mode === 'calibrating' && <div className="progress"><span style={{ width: `${progress * 100}%` }} /></div>}
        </div>
        {running && <div className={`badge ${tracking}`}>{mode === 'demo' ? 'Synthetic demo' : `Tracking: ${tracking}`}</div>}
      </main>
      <aside className="panel">
        <h1>Live shirt try-on</h1>
        <section className="card">
          <strong>Regular Fit T-shirt, white</strong>
          <small>Built-in procedural template. Not a SewFormer reconstruction.</small>
          <label>Size
            <select value={size} onChange={(e) => changeSize(e.target.value as ShirtSize)}>
              {SIZES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label>Your height (cm)
            <input type="number" min={130} max={220} value={heightCm} disabled={running} onChange={(e) => setHeightCm(Number(e.target.value))} />
          </label>
        </section>
        <div className="actions">
          <button className="primary" onClick={startCamera}>Start camera</button>
          <button onClick={startDemo}>Synthetic demo</button>
          <button onClick={stop} disabled={mode === 'idle'}>Stop</button>
        </div>
        {message && <p className={mode === 'error' ? 'msg error' : 'msg'} role="status">{message}</p>}
        <label className="check"><input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} /> Developer panel</label>
        {dev && (
          <section className="card dev">
            <label className="check"><input type="checkbox" checked={wireframe} onChange={(e) => { setWireframe(e.target.checked); optsRef.current.wireframe = e.target.checked; viewRef.current?.setOptions(optsRef.current); }} /> Cloth wireframe</label>
            <label className="check"><input type="checkbox" checked={showColliders} onChange={(e) => { setShowColliders(e.target.checked); optsRef.current.showColliders = e.target.checked; viewRef.current?.setOptions(optsRef.current); }} /> Collision body</label>
            {stats && <pre data-testid="stats">{[
              `render ${stats.renderFps.toFixed(0)} fps | pose ${stats.poseFps.toFixed(0)} fps`,
              `pose p95 ${stats.poseP95.toFixed(1)} ms (${stats.delegate})`,
              `physics p50/p95 ${stats.physicsP50.toFixed(1)}/${stats.physicsP95.toFixed(1)} ms`,
              `draw p95 ${stats.renderP95.toFixed(1)} ms`,
              `verts ${stats.vertices} | strain ${(stats.strain * 100).toFixed(1)}%`,
              `slow frames ${stats.dropped} | refits ${stats.refits}`,
            ].join('\n')}</pre>}
            <small>Material is an estimated jersey preset. No self-collision yet. Occlusion uses tracked arm capsules.</small>
          </section>
        )}
      </aside>
    </div>
  );
}
