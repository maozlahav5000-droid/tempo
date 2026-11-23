"use client";

import { useEffect, useState } from "react";

const iconPaths = {
  metronome: "M9 3h4l5 17H4L9 3Zm1 12 9-11M8.5 17h5",
  notes: "M6 3.5h12.5V21H6a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2ZM8 3.5V21m3-12h4.5M11 12h4.5",
  sheet: "M5 3.5h10l4 4V21H5V3.5ZM14 4v5h4M8 12h8m-8 3h8m-8 3h5",
  projects: "M9 16V6l10-2v10M9 9l10-2M9 16c0 1.5-1.4 3-3.2 3.4-1.7.3-3-.5-3-1.8s1.4-2.7 3.1-3c1.7-.4 3.1.1 3.1 1.4Zm10-2.1c0 1.5-1.3 2.9-3.1 3.3-1.7.3-2.9-.5-2.9-1.8s1.3-2.6 3-3c1.7-.3 3 .2 3 1.5Z",
  expand: "M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5",
  collapse: "M9 4v5H4m16 0h-5V4m0 16v-5h5M4 15h5v5",
};

export function StudioIcon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

export function FullscreenButton() {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const sync = () => {
      setAvailable(Boolean(document.fullscreenEnabled));
      setActive(Boolean(document.fullscreenElement));
      setError(false);
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (!available) return null;
  const label = active ? "יציאה ממסך מלא" : "מסך מלא";
  async function toggle() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError(true);
    }
  }
  return (
    <div className="display-tools">
      <button type="button" onClick={toggle} aria-label={label} aria-pressed={active} title={label}>
        <StudioIcon name={active ? "collapse" : "expand"} /><span>{label}</span>
      </button>
      {error && <span role="status" className="display-message">הדפדפן חסם את המעבר למסך מלא.</span>}
    </div>
  );
}
