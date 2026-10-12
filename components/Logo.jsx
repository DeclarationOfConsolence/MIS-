"use client";

import { useState } from "react";

// Shows /logo.png on a white chip. If the file isn't there yet, falls back to
// the "N" badge so nothing looks broken.
export default function Logo({ size = 44, rounded = "rounded-xl", className = "" }) {
  const [failed, setFailed] = useState(false);
  const base = `${rounded} flex items-center justify-center shadow overflow-hidden ${className}`;

  if (failed) {
    return (
      <div
        className={`${base} bg-gradient-to-br from-indigo-500 to-indigo-700 text-white font-bold`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      >
        N
      </div>
    );
  }

  return (
    <div className={`${base} bg-white`} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="NapChief"
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </div>
  );
}
