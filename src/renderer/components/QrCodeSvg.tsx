import React, { useMemo } from "react";
import QRCode from "qrcode";

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export interface QrSvgData {
  moduleCount: number;
  viewBoxSize: number;
  pathD: string;
}

/**
 * Synchronously computes a compact SVG path for a QR code.
 * Pure & deterministic — works identically in Electron renderer and SSR/Vitest.
 */
export function buildQrSvgData(
  value: string,
  options?: { errorCorrectionLevel?: QrErrorCorrectionLevel; margin?: number },
): QrSvgData | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const margin = Math.max(0, options?.margin ?? 2);
  const qr = QRCode.create(trimmed, {
    errorCorrectionLevel: options?.errorCorrectionLevel ?? "M",
  });
  const count = qr.modules.size;
  const parts: string[] = [];

  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.modules.get(row, col)) {
        col += 1;
        continue;
      }
      const startCol = col;
      while (col < count && qr.modules.get(row, col)) {
        col += 1;
      }
      const runLength = col - startCol;
      parts.push(`M${startCol + margin} ${row + margin}h${runLength}v1h-${runLength}z`);
    }
  }

  return {
    moduleCount: count,
    viewBoxSize: count + margin * 2,
    pathD: parts.join(""),
  };
}

export interface QrCodeSvgProps {
  value: string;
  size?: number;
  margin?: number;
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  ariaLabel: string;
  testId?: string;
  className?: string;
}

/**
 * Renders a high-contrast, offline SVG QR code with a guaranteed white quiet-zone
 * background so mobile cameras scan reliably in both light and dark desktop themes.
 */
export const QrCodeSvg: React.FC<QrCodeSvgProps> = ({
  value,
  size = 148,
  margin = 2,
  errorCorrectionLevel = "M",
  ariaLabel,
  testId,
  className = "",
}) => {
  const svgData = useMemo(
    () => buildQrSvgData(value, { errorCorrectionLevel, margin }),
    [value, errorCorrectionLevel, margin],
  );

  if (!svgData) {
    return null;
  }

  return (
    <div
      className={`inline-flex items-center justify-center rounded-xl bg-white p-2 border border-zinc-200/90 dark:border-zinc-700/80 shadow-xs ${className}`}
    >
      <svg
        role="img"
        aria-label={ariaLabel}
        data-testid={testId}
        width={size}
        height={size}
        viewBox={`0 0 ${svgData.viewBoxSize} ${svgData.viewBoxSize}`}
        shapeRendering="crispEdges"
        xmlns="http://www.w3.org/2000/svg"
        className="block"
      >
        <rect
          x={0}
          y={0}
          width={svgData.viewBoxSize}
          height={svgData.viewBoxSize}
          fill="#ffffff"
        />
        <path d={svgData.pathD} fill="#09090b" />
      </svg>
    </div>
  );
};
