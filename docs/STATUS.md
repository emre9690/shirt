# Project status

Last updated 2026-11-24. Measured on an Intel Core Ultra 7 255H with Intel Arc integrated graphics (browser) and an NVIDIA RTX PRO 1000 Blackwell (SewFormer), in headless Chromium.

## Implemented and executed

- XPBD cloth with a fixed timestep, gravity, damping, torso and arm collision, and recovery from tracking jumps.
- A sewn T-shirt with front, back, two sleeves, and a neckband, drawn with real thickness.
- MediaPipe pose tracking, filtering, and image alignment, run through the real camera path using a fake video device showing one product photo.
- URL import with private-network protection, image upload fallback, background jobs, and hash-verified garment packages.
- SewFormer inference on the H&M product photo with the original checkpoint at commit `281202a`, in about 4 seconds per image.
- A garment built from that prediction, loaded from cache into the live view without rerunning the model.
- GLB export, checked by a headless import into Blender 5.3.

| Measurement, one static photo through the camera path | Result |
| --- | --- |
| Render and pose rate | 43-46 FPS |
| Pose inference, p95 | about 25 ms (GPU delegate) |
| Physics step in worker, p50 / p95 | about 25 / 29 ms |
| Draw, p95 | 0.5 ms |
| Simulation vertices | 1,659 |
| Worst edge stretch at rest | about 10-17% |
| Worst edge stretch, 12 s synthetic motion | under 35% |

## Implemented but unverified

- **A real person on a live camera with the current version.** An earlier version was tried and looked wrong. Everything since has been tested on one still photo and on synthetic motion.
- Turning, one-arm movement, crossed arms, leaving and re-entering the frame, and long sessions with a real person.
- Forearm occlusion in front of the chest.
- Motion-to-display latency, which has not been measured.
- Physical accuracy. The shirt has not been compared with the real garment.

## Approximate by design

- **The shirt is SewFormer-guided, not a direct reconstruction.** Its proportions come from the prediction, but the panels are the template's. The predicted panels are not meshed directly.
- SewFormer has no neckband class, and its back-neck depth (12.3 cm) was implausible and limited to 4 cm.
- Published width is assumed to be chest circumference. H&M's page does not define it.
- Fabric values are estimated and uncalibrated. The listed 205 g product weight is not used as fabric density.
- The body is made of capsules. Body panels do not collide with arms, and there is no self-collision, so fabric can pass through itself when arms cross.
- Existing clothing that extends past the virtual shirt stays visible.

## Blocked or not implemented

- **H&M URL import:** the site returned HTTP 403 to the service. This is not bypassed. Upload a photo instead.
- Meshing SewFormer's predicted panels directly.
- A WebGPU solver. The CPU worker is the only physics path.
- A second reconstructed garment or size, to expose assumptions specific to this photo.
- A diagnostic page and a screen recording.

## Licensing

Not cleared for commercial use. The SewFormer repository has no license file and its checkpoint has no license tag. Other dependencies have not been reviewed.

## Priorities

1. Test with a real person and fix what that shows.
2. Replace capsules with a smoother body so cloth rests naturally at the shoulders and underarms.
3. Add self-collision and finer folds.
4. Mesh SewFormer's panels directly and validate on more garments.
5. Calibrate fabric against the physical shirt.
