let canvas: HTMLCanvasElement | undefined;
/** Normalize Chromium's CSS Color 4 output to Electron/native-picker sRGB values. */
export function cssColorChannels(value: string) {
  if (!CSS.supports("color", value)) throw new Error(`This device cannot render the CSS color ${value}.`);
  canvas ??= document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
  const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
  if (!context) throw new Error("sRGB color conversion is unavailable; the previous native window effect is retained.");
  context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  return { red: red!, green: green!, blue: blue!, alpha: alpha! / 255 };
}
export function cssColorToRgba(value: string) { const { red, green, blue, alpha } = cssColorChannels(value); return `rgba(${red}, ${green}, ${blue}, ${alpha})`; }
export function cssColorToHex(value: string) { const { red, green, blue } = cssColorChannels(value); return `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, "0")).join("")}`; }
