function parseColor(value) {
  const raw = String(value || "").trim();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3
      ? hex[1].split("").map((digit) => `${digit}${digit}`).join("")
      : hex[1];
    return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16) / 255);
  }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return rgb.slice(1, 4).map((channel) => Math.min(255, Number(channel)) / 255);
  return null;
}

function relativeLuminance(rgb) {
  return rgb.reduce((sum, channel, index) => {
    const linear = channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrastRatio(foregroundLuminance, backgroundLuminance) {
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Select the more readable of the light/dark foregrounds for a color. */
export function readableForegroundColor(background, light = "#FFFFFF", dark = "#122647") {
  const rgb = parseColor(background);
  if (!rgb) return dark;
  const backgroundLuminance = relativeLuminance(rgb);
  const lightLuminance = relativeLuminance(parseColor(light) || [1, 1, 1]);
  const darkLuminance = relativeLuminance(parseColor(dark) || [0.07, 0.15, 0.28]);
  return contrastRatio(lightLuminance, backgroundLuminance) >= contrastRatio(darkLuminance, backgroundLuminance)
    ? light
    : dark;
}
