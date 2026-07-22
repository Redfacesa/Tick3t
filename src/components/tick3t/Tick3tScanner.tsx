import { useCallback, useEffect, useRef, useState } from 'react';
import { cls } from '@/lib/format';
import { parseTick3tQr } from '@/lib/tick3t/qr';

type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => BarcodeDetectorLike;
  }
}

export default function Tick3tScanner({
  onScan,
  busy,
}: {
  onScan: (payload: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [useCamera, setUseCamera] = useState(true);

  const stopCamera = useCallback(() => {
    if (loopRef.current) {
      window.clearInterval(loopRef.current);
      loopRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraReady(false);
  }, []);

  useEffect(() => {
    if (!useCamera) {
      stopCamera();
      return;
    }

    let on = true;
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setUseCamera(false);
        setError('Camera not available on this device.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        if (!on) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraReady(true);
        setError('');

        if (window.BarcodeDetector) {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          loopRef.current = window.setInterval(async () => {
            const video = videoRef.current;
            if (!video || video.readyState < 2 || busy) return;
            try {
              const codes = await detector.detect(video);
              const raw = codes[0]?.rawValue;
              if (raw && parseTick3tQr(raw)) {
                stopCamera();
                void onScan(raw);
              }
            } catch {
              /* ignore frame errors */
            }
          }, 500);
        }
      } catch {
        setUseCamera(false);
        setError('Camera access denied. Enter the code manually.');
      }
    };

    void start();
    return () => {
      on = false;
      stopCamera();
    };
  }, [useCamera, stopCamera, onScan, busy]);

  const submitManual = () => {
    const value = manual.trim();
    if (!value) return;
    void onScan(value);
    setManual('');
  };

  return (
    <div className="space-y-4">
      {useCamera ? (
        <div className="relative overflow-hidden rounded-2xl border border-white/12 bg-black">
          <video
            ref={videoRef}
            className="aspect-[4/3] w-full object-cover"
            playsInline
            muted
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-48 w-48 rounded-xl border-2 border-brand/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
          {!cameraReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white/70">
              Starting camera…
            </div>
          )}
          {cameraReady && !window.BarcodeDetector && (
            <p className="absolute bottom-3 left-3 right-3 rounded-lg bg-black/70 px-3 py-2 text-center text-[11px] text-white/70">
              Point camera at QR, then enter code below if auto-scan is unavailable.
            </p>
          )}
        </div>
      ) : null}

      {error && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitManual()}
          placeholder="Paste QR payload or ticket code"
          className="min-w-0 flex-1 rounded-xl border border-white/12 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/35"
          disabled={busy}
        />
        <button
          type="button"
          onClick={submitManual}
          disabled={busy || !manual.trim()}
          className={cls(
            'min-h-[44px] rounded-xl bg-[#FF4B4B] px-4 py-2 text-sm font-bold text-white',
            (busy || !manual.trim()) && 'opacity-40',
          )}
        >
          Verify
        </button>
      </div>

      {useCamera && (
        <button
          type="button"
          onClick={() => setUseCamera(false)}
          className="text-xs font-semibold text-white/45 underline-offset-2 hover:text-white/70 hover:underline"
        >
          Use manual entry only
        </button>
      )}
      {!useCamera && (
        <button
          type="button"
          onClick={() => {
            setUseCamera(true);
            setError('');
          }}
          className="text-xs font-semibold text-brand underline-offset-2 hover:underline"
        >
          Try camera again
        </button>
      )}
    </div>
  );
}
