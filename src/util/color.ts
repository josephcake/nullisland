import {NullIslandConfigError} from '../errors.ts';
import type {Color, RGBA} from '../types.ts';

/** Parse a CSS hex color or RGBA tuple into 0-255 channels. */
export function parseColor(color: Color): RGBA {
  if (Array.isArray(color)) {
    const [r, g, b, a = 255] = color;
    for (const channel of [r, g, b, a]) {
      if (!Number.isFinite(channel) || channel < 0 || channel > 255) {
        throw new NullIslandConfigError(`Invalid color channel: ${channel}`);
      }
    }
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(a)];
  }

  if (typeof color !== 'string') {
    throw new NullIslandConfigError('Color must be a hex string or RGBA tuple');
  }

  const value = color.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(value) || ![3, 4, 6, 8].includes(value.length)) {
    throw new NullIslandConfigError(`Invalid color: ${color}`);
  }

  const expand = value.length <= 4 ? [...value].map((c) => c + c).join('') : value;
  const channels = (expand.match(/.{2}/g) ?? []).map((c) => Number.parseInt(c, 16));
  const [r = 0, g = 0, b = 0, a = 255] = channels;
  return [r, g, b, a];
}

export function rgbaToCss([r, g, b, a]: RGBA): string {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

/** Multiply a color's alpha by an opacity factor in [0, 1]. */
export function applyOpacity(color: RGBA, opacity: number): RGBA {
  return [color[0], color[1], color[2], Math.round(color[3] * opacity)];
}

export function isDark([r, g, b]: RGBA): boolean {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
