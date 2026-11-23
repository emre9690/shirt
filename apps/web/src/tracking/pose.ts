import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from './body';

export interface PoseResult {
  image: Landmark[];
  world: Landmark[];
}

export interface PoseTracker {
  delegate: 'GPU' | 'CPU';
  detect(video: HTMLVideoElement, timestampMs: number): PoseResult | null;
  close(): void;
}

/** Runs entirely in the browser from self-hosted assets. No frames leave the device. */
export async function createPoseTracker(): Promise<PoseTracker> {
  const base = import.meta.env.BASE_URL;
  const vision = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
  const make = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_full.task`, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let delegate: 'GPU' | 'CPU' = 'GPU';
  let landmarker: PoseLandmarker;
  try {
    landmarker = await make('GPU');
  } catch {
    delegate = 'CPU';
    landmarker = await make('CPU');
  }
  return {
    delegate,
    detect(video, timestampMs) {
      const r = landmarker.detectForVideo(video, timestampMs);
      if (!r.landmarks.length || !r.worldLandmarks.length) return null;
      return { image: r.landmarks[0], world: r.worldLandmarks[0] };
    },
    close: () => landmarker.close(),
  };
}
